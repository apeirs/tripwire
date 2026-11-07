// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {Fixture} from "./utils/Fixture.sol";
import {MockSystem} from "./mocks/MockSystem.sol";
import {SpyERC20} from "./mocks/WeirdTokens.sol";
import {Guardian} from "../src/Guardian.sol";
import {TripwireReactive} from "../src/TripwireReactive.sol";

contract TripwireReactiveTest is Fixture {
    event Tripped(
        uint256 indexed tripId,
        TripwireReactive.Reason indexed reason,
        uint256 indexed chainId,
        uint256 txHash,
        uint256 logIndex
    );

    // ------------------------------------------------------------ construction and config

    function test_constructor_subscribesSignalsOnly() public {
        TripwireReactive t = new TripwireReactive(hot, cold, cosigner, ids, _addrs(3, 1), _addrs(3, 2));
        // per chain: Intend(cosigner) + Panic(hot) + Panic(cosigner)
        assertEq(sys.activeSubs(address(t)), 9);
        TripwireReactive same = new TripwireReactive(hot, cold, hot, ids, _addrs(3, 1), _addrs(3, 2));
        assertEq(sys.activeSubs(address(same)), 6, "cosigner == hot needs one panic sub");
        TripwireReactive bare = new TripwireReactive(hot, cold, cosigner, ids, _addrs(3, 0), _addrs(3, 0));
        assertEq(sys.activeSubs(address(bare)), 0);
    }

    function test_constructor_rejectsBadConfig() public {
        vm.expectRevert(TripwireReactive.HotIsCold.selector);
        new TripwireReactive(hot, hot, cosigner, ids, _addrs(3, 0), _addrs(3, 0));
        vm.expectRevert(TripwireReactive.ZeroAddress.selector);
        new TripwireReactive(hot, address(0), cosigner, ids, _addrs(3, 0), _addrs(3, 0));
        vm.expectRevert(TripwireReactive.BadConfig.selector);
        new TripwireReactive(hot, cold, cosigner, ids, _addrs(2, 0), _addrs(3, 0));
        uint256[] memory dup = new uint256[](2);
        dup[0] = BASE;
        dup[1] = BASE;
        vm.expectRevert(TripwireReactive.BadConfig.selector);
        new TripwireReactive(hot, cold, cosigner, dup, _addrs(2, 0), _addrs(2, 0));
        vm.expectRevert(TripwireReactive.TooMany.selector);
        new TripwireReactive(hot, cold, cosigner, new uint256[](0), _addrs(0, 0), _addrs(0, 0));
    }

    function test_addToken_subscribesTransferAndApproval_removeUnsubscribes() public {
        uint256 before = sys.activeSubs(address(tw));
        SpyERC20 extra = new SpyERC20("X", "X");
        tw.addToken(BASE, address(extra), 5);
        assertEq(sys.activeSubs(address(tw)), before + 2);
        assertEq(tw.tokens(BASE).length, TOKENS + 1);
        assertEq(tw.threshold(BASE, address(extra)), 5);

        vm.expectRevert(abi.encodeWithSelector(TripwireReactive.AlreadyWatched.selector, address(extra)));
        tw.addToken(BASE, address(extra), 5);

        tw.removeToken(BASE, address(extra));
        assertEq(sys.activeSubs(address(tw)), before);
        assertEq(tw.tokens(BASE).length, TOKENS);
        assertFalse(tw.watched(BASE, address(extra)));
    }

    function test_config_onlyOwner(address stranger_) public {
        vm.assume(stranger_ != address(this));
        vm.startPrank(stranger_);
        vm.expectRevert(TripwireReactive.NotOwner.selector);
        tw.setGuardian(BASE, stranger_);
        vm.expectRevert(TripwireReactive.NotOwner.selector);
        tw.addToken(BASE, stranger_, 0);
        vm.expectRevert(TripwireReactive.NotOwner.selector);
        tw.setTrusted(stranger_, true);
        vm.expectRevert(TripwireReactive.NotOwner.selector);
        tw.setThreshold(BASE, address(_token(BASE, 0)), 1);
        vm.expectRevert(TripwireReactive.NotOwner.selector);
        tw.setOwner(stranger_);
        vm.stopPrank();
    }

    function test_config_limits() public {
        vm.expectRevert(abi.encodeWithSelector(TripwireReactive.UnknownChain.selector, 1));
        tw.setGuardian(1, address(1));
        for (uint256 i = TOKENS; i < tw.MAX_TOKENS_PER_CHAIN(); ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            tw.addToken(BASE, address(uint160(0x1000 + i)), 0);
        }
        vm.expectRevert(TripwireReactive.TooMany.selector);
        tw.addToken(BASE, address(0xdead), 0);
    }

    // ------------------------------------------------------------ react() authorisation

    function testFuzz_react_onlySystem(address caller_) public {
        vm.assume(caller_ != SYSTEM_ADDR);
        IReactive.LogRecord memory rec = _transferRecord(BASE, address(_token(BASE, 0)), hot, attacker, 1e18);
        vm.prank(caller_);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, caller_, SYSTEM_ADDR));
        tw.react(rec);
        assertEq(tw.trips(), 0);
    }

    // ------------------------------------------------------------ transfer rules

    function test_transfer_toStranger_tripsAndRequestsSweepOnEveryChain() public {
        _hotTransfer(BASE, 0, attacker, 1e18);
        assertEq(tw.trips(), 1);
        assertEq(sys.requestCount(), 3);
        for (uint256 i; i < 3; ++i) {
            MockSystem.Req memory r = sys.request(i);
            assertEq(r.chainId, ids[i]);
            assertEq(r.sender, address(tw));
            assertEq(r.recipient, address(chains[ids[i]].guardian));
            assertEq(r.gasLimit, tw.callbackGasLimit(TOKENS));
            (address placeholder, uint256 tripId, address[] memory list) = _decodeSweep(r.payload);
            assertEq(placeholder, address(0), "first arg must be the placeholder");
            assertEq(tripId, 1);
            assertEq(list.length, TOKENS);
            assertEq(list[2], address(_token(ids[i], 2)));
        }
    }

    function test_transfer_toCold_orTrusted_neverTrips() public {
        _hotTransfer(BASE, 0, cold, 10e18);
        tw.setTrusted(shop, true);
        _hotTransfer(ETH, 1, shop, 10e18);
        assertEq(tw.trips(), 0);
        assertEq(sys.requestCount(), 0);
    }

    function testFuzz_threshold(uint256 threshold_, uint256 amount_) public {
        threshold_ = bound(threshold_, 0, START);
        amount_ = bound(amount_, 1, START);
        tw.setThreshold(UNI, address(_token(UNI, 1)), threshold_);
        _hotTransfer(UNI, 1, attacker, amount_);
        assertEq(tw.trips(), amount_ > threshold_ ? 1 : 0);
    }

    function test_ignored_wrongSenderTokenChainOrShape() public {
        // not from HOT (a fake log can't even get here without a matching subscription, but react() rechecks)
        _react(_transferRecord(BASE, address(_token(BASE, 0)), attacker, cold, 1e18));
        // unwatched token
        _react(_transferRecord(BASE, address(0xbeef), hot, attacker, 1e18));
        // unknown chain
        _react(_transferRecord(1, address(_token(BASE, 0)), hot, attacker, 1e18));
        // wrong shape: LOG1-style Transfer with nothing indexed
        IReactive.LogRecord memory rec = _transferRecord(BASE, address(_token(BASE, 0)), hot, attacker, 1e18);
        rec.opCode = 1;
        _react(rec);
        // no data
        rec = _transferRecord(BASE, address(_token(BASE, 0)), hot, attacker, 1e18);
        rec.data = "";
        _react(rec);
        assertEq(tw.trips(), 0);
    }

    function test_removedToken_noLongerTrips() public {
        tw.removeToken(ETH, address(_token(ETH, 0)));
        _react(_transferRecord(ETH, address(_token(ETH, 0)), hot, attacker, 1e18));
        assertEq(tw.trips(), 0);
    }

    // ------------------------------------------------------------ intents

    function test_intent_clearsExactTransfer_thenIsUsedUp() public {
        _intend(BASE, cosigner, 0, shop, 30e18, 1 hours);
        _hotTransfer(BASE, 0, shop, 20e18);
        _hotTransfer(BASE, 0, shop, 10e18);
        assertEq(tw.trips(), 0, "30 of 30 used");
        _hotTransfer(BASE, 0, shop, 1);
        assertEq(tw.trips(), 1, "nothing left");
    }

    function testFuzz_intent_amountCap(uint128 intended_, uint128 sent_) public {
        intended_ = uint128(bound(intended_, 1, START));
        sent_ = uint128(bound(sent_, 1, START));
        _intend(BASE, cosigner, 0, shop, intended_, 1 hours);
        _hotTransfer(BASE, 0, shop, sent_);
        assertEq(tw.trips(), sent_ > intended_ ? 1 : 0);
    }

    function testFuzz_intent_expiryHonoured(uint64 ttl_, uint256 wait_) public {
        ttl_ = uint64(bound(ttl_, 1, 1 days));
        wait_ = bound(wait_, 0, 2 days);
        _intend(ETH, cosigner, 2, shop, 5e18, ttl_);
        vm.warp(block.timestamp + wait_);
        _hotTransfer(ETH, 2, shop, 5e18);
        assertEq(tw.trips(), wait_ > ttl_ ? 1 : 0);
    }

    function test_intent_onlyCosigner_onlyItsChain_onlyItsTokenAndRecipient() public {
        _intend(BASE, hot, 0, shop, 5e18, 1 hours); // hot isn't the cosigner: no subscription, never arrives
        _intend(BASE, attacker, 0, attacker, 5e18, 1 hours);
        _hotTransfer(BASE, 0, shop, 5e18);
        assertEq(tw.trips(), 1);

        _intend(ETH, cosigner, 0, shop, 5e18, 1 hours);
        _hotTransfer(UNI, 0, shop, 5e18); // other chain
        assertEq(tw.trips(), 2);
        _hotTransfer(ETH, 1, shop, 5e18); // other token
        assertEq(tw.trips(), 3);
        _hotTransfer(ETH, 0, attacker, 5e18); // other recipient
        assertEq(tw.trips(), 4);
        _hotTransfer(ETH, 0, shop, 5e18); // the intended one
        assertEq(tw.trips(), 4);
    }

    function test_intent_fromForeignContractIgnored() public {
        // Same event, same cosigner topic, but emitted by a contract that isn't the configured Intent.
        IReactive.LogRecord memory rec = _intendRecord(BASE, address(0xFA4E), cosigner, address(_token(BASE, 0)), shop);
        _react(rec);
        _hotTransfer(BASE, 0, shop, 5e18);
        assertEq(tw.trips(), 1);
    }

    function test_intent_tooLongIgnored_zeroCancels() public {
        IReactive.LogRecord memory rec =
            _intendRecord(BASE, address(chains[BASE].intent), cosigner, address(_token(BASE, 0)), shop);
        rec.data = abi.encode(uint256(5e18), uint64(block.timestamp + 2 days));
        _react(rec);
        (uint128 amount,) = tw.intents(tw.intentKey(BASE, address(_token(BASE, 0)), shop));
        assertEq(amount, 0, "ttl over a day is ignored");

        _intend(BASE, cosigner, 0, shop, 5e18, 1 hours);
        _intend(BASE, cosigner, 0, shop, 0, 1 hours);
        _hotTransfer(BASE, 0, shop, 5e18);
        assertEq(tw.trips(), 1, "zero intent cancelled the earlier one");
    }

    // ------------------------------------------------------------ approvals

    function test_approval_rules() public {
        _hotApprove(BASE, 0, attacker, type(uint256).max);
        assertEq(tw.trips(), 1, "unknown spender trips");

        tw.setTrusted(shop, true);
        _hotApprove(BASE, 0, shop, type(uint256).max);
        _hotApprove(BASE, 0, attacker, 0); // revoking anything is fine
        _hotApprove(BASE, 0, address(chains[BASE].guardian), type(uint256).max);
        assertEq(tw.trips(), 1);

        _hotApprove(BASE, 0, address(chains[BASE].guardian), 0);
        assertEq(tw.trips(), 2, "guardian revoke trips");
        _hotApprove(BASE, 1, address(chains[BASE].guardian), 1);
        assertEq(tw.trips(), 3, "guardian cut to dust trips");
    }

    function test_approval_intended_doesNotTrip() public {
        address router = makeAddr("router");
        _intend(UNI, cosigner, 1, router, 50e18, 10 minutes);
        _hotApprove(UNI, 1, router, 50e18);
        assertEq(tw.trips(), 0);
    }

    // ------------------------------------------------------------ panic

    function test_panic_fromHotOrCosigner_trips_strangerIgnored() public {
        _panic(ETH, attacker);
        assertEq(tw.trips(), 0);
        _panic(ETH, cosigner);
        assertEq(tw.trips(), 1);
        _panic(UNI, hot);
        assertEq(tw.trips(), 2);

        // A forged Panic record from the wrong contract (only reachable if a subscription matched) is ignored too.
        IReactive.LogRecord memory rec = _panicRecord(UNI, address(0xbad), hot);
        _react(rec);
        assertEq(tw.trips(), 2);
    }

    // ------------------------------------------------------------ dedupe and coalescing

    function test_dedupe_sameLogTwice_tripsOnce() public {
        IReactive.LogRecord memory rec = _transferRecord(BASE, address(_token(BASE, 0)), hot, attacker, 1e18);
        _react(rec);
        _react(rec);
        assertEq(tw.trips(), 1);
        assertEq(sys.requestCount(), 3);
        assertTrue(tw.seen(keccak256(abi.encode(rec.chainId, rec.txHash, rec.logIndex))));
    }

    function testFuzz_dedupe_keyIsChainTxLog(uint256 txHash_, uint256 logIndex_) public {
        IReactive.LogRecord memory rec = _transferRecord(BASE, address(_token(BASE, 0)), hot, attacker, 1e18);
        rec.txHash = txHash_;
        rec.logIndex = logIndex_;
        _react(rec);
        // same tx and log index on another chain is a different log
        rec.chainId = ETH;
        rec.contractAddress = address(_token(ETH, 0));
        _react(rec);
        assertEq(tw.trips(), 2);
    }

    function test_coalesce_oneTripPerOriginTx() public {
        // A multicall drain: three Transfer logs in one transaction.
        IReactive.LogRecord memory rec = _transferRecord(BASE, address(_token(BASE, 0)), hot, attacker, 1e18);
        _react(rec);
        rec.logIndex = 1;
        rec.contractAddress = address(_token(BASE, 1));
        _react(rec);
        rec.logIndex = 2;
        rec.contractAddress = address(_token(BASE, 2));
        _react(rec);
        assertEq(tw.trips(), 1);
        assertEq(sys.requestCount(), 3);
        // the next transaction trips again
        rec.txHash = 42;
        _react(rec);
        assertEq(tw.trips(), 2);
    }

    function test_noGuardian_noCallbackForThatChain() public {
        tw.setGuardian(ETH, address(0));
        _hotTransfer(BASE, 0, attacker, 1e18);
        assertEq(sys.requestCount(), 2);
        for (uint256 i; i < 2; ++i) {
            assertTrue(sys.request(i).chainId != ETH);
        }
    }

    function test_callbackGasLimit_aboveNetworkMinimum() public view {
        assertGe(tw.callbackGasLimit(0), 100_000);
        assertEq(tw.callbackGasLimit(16), tw.CALLBACK_BASE_GAS() + 16 * tw.CALLBACK_GAS_PER_TOKEN());
    }

    // ------------------------------------------------------------ helpers

    function _react(IReactive.LogRecord memory rec_) internal {
        vm.prank(SYSTEM_ADDR);
        tw.react(rec_);
    }

    function _addrs(uint256 n_, uint256 seed_) internal pure returns (address[] memory out_) {
        out_ = new address[](n_);
        for (uint256 i; i < n_; ++i) {
            // forge-lint: disable-next-line(unsafe-typecast)
            out_[i] = seed_ == 0 ? address(0) : address(uint160(seed_ * 1000 + i + 1));
        }
    }

    function _transferRecord(uint256 chainId_, address token_, address from_, address to_, uint256 amount_)
        internal
        view
        returns (IReactive.LogRecord memory)
    {
        return IReactive.LogRecord({
            chainId: chainId_,
            contractAddress: token_,
            topic0: tw.TRANSFER_TOPIC_0(),
            topic1: uint256(uint160(from_)),
            topic2: uint256(uint160(to_)),
            topic3: 0,
            data: abi.encode(amount_),
            blockNumber: block.number,
            opCode: 3,
            blockHash: 1,
            txHash: uint256(keccak256("tx")),
            logIndex: 0
        });
    }

    function _intendRecord(uint256 chainId_, address emitter_, address owner_, address token_, address to_)
        internal
        view
        returns (IReactive.LogRecord memory)
    {
        return IReactive.LogRecord({
            chainId: chainId_,
            contractAddress: emitter_,
            topic0: tw.INTEND_TOPIC_0(),
            topic1: uint256(uint160(owner_)),
            topic2: uint256(uint160(token_)),
            topic3: uint256(uint160(to_)),
            data: abi.encode(uint256(5e18), uint64(block.timestamp + 1 hours)),
            blockNumber: block.number,
            opCode: 4,
            blockHash: 1,
            txHash: uint256(keccak256("intent-tx")),
            logIndex: 0
        });
    }

    function _panicRecord(uint256 chainId_, address emitter_, address caller_)
        internal
        view
        returns (IReactive.LogRecord memory)
    {
        return IReactive.LogRecord({
            chainId: chainId_,
            contractAddress: emitter_,
            topic0: tw.PANIC_TOPIC_0(),
            topic1: uint256(uint160(caller_)),
            topic2: 0,
            topic3: 0,
            data: "",
            blockNumber: block.number,
            opCode: 2,
            blockHash: 1,
            txHash: uint256(keccak256("panic-tx")),
            logIndex: 0
        });
    }

    function _decodeSweep(bytes memory payload_) internal pure returns (address, uint256, address[] memory) {
        bytes4 sel;
        assembly {
            sel := mload(add(payload_, 32))
        }
        require(sel == Guardian.sweep.selector, "selector");
        bytes memory args = new bytes(payload_.length - 4);
        for (uint256 i; i < args.length; ++i) {
            args[i] = payload_[i + 4];
        }
        return abi.decode(args, (address, uint256, address[]));
    }
}
