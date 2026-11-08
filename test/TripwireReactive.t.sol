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
    event TripMerged(
        uint256 indexed tripId,
        TripwireReactive.Reason indexed reason,
        uint256 indexed chainId,
        uint256 txHash,
        uint256 logIndex
    );
    event Observed(
        uint256 indexed chainId,
        uint256 indexed topic0,
        address indexed counterparty,
        uint256 amount,
        TripwireReactive.Verdict verdict,
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
        _waitOutWindow();
        _hotTransfer(UNI, 0, shop, 5e18); // other chain
        assertEq(tw.trips(), 2);
        _waitOutWindow();
        _hotTransfer(ETH, 1, shop, 5e18); // other token
        assertEq(tw.trips(), 3);
        _waitOutWindow();
        _hotTransfer(ETH, 0, attacker, 5e18); // other recipient
        assertEq(tw.trips(), 4);
        _waitOutWindow();
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

        _waitOutWindow();
        _hotApprove(BASE, 0, address(chains[BASE].guardian), 0);
        assertEq(tw.trips(), 2, "guardian revoke trips");
        _waitOutWindow();
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
        _waitOutWindow();
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
        _waitOutWindow();
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
        // without the time window, the next transaction trips again
        tw.setTripCooldown(0);
        rec.txHash = 42;
        _react(rec);
        assertEq(tw.trips(), 2);
        assertEq(sys.requestCount(), 6);
    }

    // ------------------------------------------------------------ merge window

    /// The attack from the review: the hot key's holder sends phishing approvals in separate transactions to burn
    /// the reserves. Inside the window they cost one sweep set, and each is still on record.
    function test_window_repeatedPhishingApprovals_oneSweepSet() public {
        _hotApprove(BASE, 0, attacker, type(uint256).max);
        assertEq(tw.trips(), 1);
        assertEq(sys.requestCount(), 3);
        for (uint256 i; i < 6; ++i) {
            vm.warp(block.timestamp + 40); // 6 x 40 s = 240 s, inside the 300 s window
            uint256 c = ids[i % 3];
            vm.recordLogs();
            vm.prank(hot);
            _token(c, i % TOKENS).approve(attacker, type(uint256).max);
            IReactive.LogRecord memory rec = _record(c, vm.getRecordedLogs()[0], 1000 + i, 0);
            vm.expectEmit(true, true, true, true, address(tw));
            emit TripMerged(1, TripwireReactive.Reason.Approval, c, 1000 + i, 0);
            _react(rec);
        }
        // a transfer and a Guardian revoke from the hot key merge too
        _hotTransfer(UNI, 1, attacker, 1e18);
        _hotApprove(ETH, 2, address(chains[ETH].guardian), 0);
        assertEq(tw.trips(), 1, "one trip");
        assertEq(sys.requestCount(), 3, "one callback per chain, not one per approval");
        assertEq(_relay(), 0);
        // the revoked token stays put (that's what revoking the guard does); everything else went home once
        assertEq(_coldTotal(), (3 * TOKENS - 1) * START - 1e18, "everything else swept by the one sweep set");
        assertEq(_token(ETH, 2).balanceOf(hot), START);
    }

    /// Merged moves don't extend the window: a thief can't keep it open with a move every few minutes and then
    /// drain after it.
    function test_window_mergedMovesDontExtendIt() public {
        _hotApprove(BASE, 0, attacker, type(uint256).max);
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 299);
        _hotApprove(BASE, 1, attacker, type(uint256).max);
        assertEq(tw.trips(), 1, "merged at 299 s");
        vm.warp(t0 + 300);
        _hotApprove(BASE, 2, attacker, type(uint256).max);
        assertEq(tw.trips(), 2, "the window is 300 s from the trip that fired");
        assertEq(tw.lastTripAt(), t0 + 300);
    }

    /// The thief waits out the window, then acts again (e.g. after the victim tops up HOT): the new move re-trips and
    /// the new funds go home too.
    function test_window_postWindowMove_newTrip() public {
        _hotApprove(BASE, 0, attacker, type(uint256).max);
        assertEq(_relay(), 0);
        assertEq(_coldTotal(), 3 * TOKENS * START);

        _waitOutWindow();
        _token(BASE, 1).mint(hot, 50e18);
        _hotApprove(BASE, 1, address(0xD5A1), type(uint256).max);
        assertEq(tw.trips(), 2);
        assertEq(sys.requestCount(), 6);
        assertEq(_relay(), 0);
        assertEq(_token(BASE, 1).balanceOf(cold), START + 50e18, "the top-up was swept by trip #2");
    }

    /// The cosigner's panic is the owner's override: it fires inside the window (and starts a new one).
    function test_window_cosignerPanicStillFires() public {
        _hotApprove(BASE, 0, attacker, type(uint256).max);
        vm.warp(block.timestamp + 10);
        IReactive.LogRecord memory rec = _panicRecord(ETH, address(chains[ETH].panic), cosigner);
        vm.expectEmit(true, true, true, true, address(tw));
        emit Tripped(2, TripwireReactive.Reason.Panic, ETH, rec.txHash, 0);
        _react(rec);
        assertEq(tw.trips(), 2);
        assertEq(sys.requestCount(), 6);
        _panic(UNI, cosigner);
        assertEq(tw.trips(), 3, "every cosigner press fires");
        assertEq(tw.lastTripAt(), block.timestamp);
    }

    /// The hot key's panic is merged like its other moves (the thief holds that key too), and fires after the window.
    function test_window_hotPanicMergesInsideWindow() public {
        _hotApprove(BASE, 0, attacker, type(uint256).max);
        for (uint256 i; i < 5; ++i) {
            _panic(ids[i % 3], hot);
        }
        assertEq(tw.trips(), 1);
        assertEq(sys.requestCount(), 3);
        _waitOutWindow();
        _panic(BASE, hot);
        assertEq(tw.trips(), 2);
    }

    function testFuzz_window_cooldown(uint64 cooldown_, uint64 gap_) public {
        cooldown_ = uint64(bound(cooldown_, 0, tw.MAX_TRIP_COOLDOWN()));
        gap_ = uint64(bound(gap_, 0, 2 days));
        tw.setTripCooldown(cooldown_);
        _hotTransfer(BASE, 0, attacker, 1e18);
        vm.warp(block.timestamp + gap_);
        _hotTransfer(ETH, 0, attacker, 1e18); // another transaction
        assertEq(tw.trips(), gap_ >= cooldown_ ? 2 : 1);
        assertEq(sys.requestCount(), gap_ >= cooldown_ ? 6 : 3);
    }

    function test_window_config() public {
        assertEq(tw.tripCooldown(), tw.DEFAULT_TRIP_COOLDOWN());
        tw.setTripCooldown(1 hours);
        assertEq(tw.tripCooldown(), 1 hours);
        uint64 tooLong = tw.MAX_TRIP_COOLDOWN() + 1;
        vm.expectRevert(TripwireReactive.TooMany.selector);
        tw.setTripCooldown(tooLong);
        vm.prank(attacker);
        vm.expectRevert(TripwireReactive.NotOwner.selector);
        tw.setTripCooldown(0);
    }

    /// Every verdict names its origin transaction and log index.
    function test_observed_carriesOriginTxAndLogIndex() public {
        IReactive.LogRecord memory rec = _transferRecord(BASE, address(_token(BASE, 0)), hot, attacker, 1e18);
        rec.txHash = 0xabc;
        rec.logIndex = 7;
        vm.expectEmit(true, true, true, true, address(tw));
        emit Observed(BASE, rec.topic0, attacker, 1e18, TripwireReactive.Verdict.Tripped, 0xabc, 7);
        _react(rec);
        rec.logIndex = 8;
        vm.expectEmit(true, true, true, true, address(tw));
        emit Observed(BASE, rec.topic0, attacker, 1e18, TripwireReactive.Verdict.Merged, 0xabc, 8);
        _react(rec);
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

    function _waitOutWindow() internal {
        vm.warp(block.timestamp + tw.tripCooldown());
    }

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
