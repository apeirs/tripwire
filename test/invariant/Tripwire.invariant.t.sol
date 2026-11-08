// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, StdInvariant, console} from "forge-std/Test.sol";
import {Fixture} from "../utils/Fixture.sol";
import {MockSystem} from "../mocks/MockSystem.sol";
import {SpyERC20} from "../mocks/WeirdTokens.sol";
import {Guardian} from "../../src/Guardian.sol";
import {Drainer} from "../../src/mocks/Drainer.sol";

/// @notice Drives the whole simulated loop with random attacker, owner and network behaviour.
contract TripwireHandler is Fixture {
    Drainer internal drainer;

    // ghosts
    uint256 public forgedSweeps;
    bool public replayMoved;
    mapping(uint256 chainId => mapping(uint256 k => uint256)) public hotToCold;
    uint256 public calls;
    /// Trips that requested sweeps inside the merge window without being a cosigner panic, or several per action.
    uint256 public windowViolations;
    uint256 internal lastFiredAt;

    function setUp() public override {
        super.setUp();
        vm.prank(attacker);
        drainer = new Drainer();
    }

    // ------------------------------------------------------------ views for the invariants

    function chainIdAt(uint256 i_) external view returns (uint256) {
        return ids[i_];
    }

    function tokenAt(uint256 chainId_, uint256 k_) external view returns (SpyERC20) {
        return _token(chainId_, k_);
    }

    function guardianOf(uint256 chainId_) external view returns (Guardian) {
        return chains[chainId_].guardian;
    }

    function coldAddr() external view returns (address) {
        return cold;
    }

    function tripCount() external view returns (uint256) {
        return tw.trips();
    }

    function coldTotal() external view returns (uint256) {
        return _coldTotal();
    }

    // ------------------------------------------------------------ actions

    /// Checks the merge window around every action: outside a cosigner panic, a trip that requests sweeps comes at
    /// least `tripCooldown` after the previous one, and one action (one origin tx, or one relay batch) fires at most
    /// one trip.
    modifier tracked(bool cosignerPanic_) {
        uint256 before = tw.trips();
        _;
        uint256 fired = tw.trips() - before;
        if (fired > 0) {
            if (fired > 1) ++windowViolations;
            if (!cosignerPanic_ && before != 0 && block.timestamp < lastFiredAt + tw.tripCooldown()) {
                ++windowViolations;
            }
            lastFiredAt = block.timestamp;
        }
    }

    function _pick(uint256 seed_) internal view returns (uint256 chainId_, uint256 k_) {
        chainId_ = ids[seed_ % 3];
        k_ = (seed_ / 3) % TOKENS;
    }

    function act_hotTransfer(uint256 seed_, uint256 amount_, uint8 toKind_) external tracked(false) {
        ++calls;
        (uint256 c, uint256 k) = _pick(seed_);
        uint256 bal = _token(c, k).balanceOf(hot);
        if (bal == 0) return;
        amount_ = bound(amount_, 1, bal);
        address to = toKind_ % 3 == 0 ? attacker : toKind_ % 3 == 1 ? shop : cold;
        if (to == cold) hotToCold[c][k] += amount_;
        _hotTransfer(c, k, to, amount_);
    }

    function act_hotApprove(uint256 seed_, uint256 amount_, uint8 spenderKind_) external tracked(false) {
        ++calls;
        (uint256 c, uint256 k) = _pick(seed_);
        uint8 s = spenderKind_ % 4;
        address spender = s == 0 ? address(drainer) : s == 1 ? address(chains[c].guardian) : s == 2 ? shop : attacker;
        _hotApprove(c, k, spender, amount_);
    }

    function act_drain(uint256 seed_) external tracked(false) {
        ++calls;
        (uint256 c, uint256 k) = _pick(seed_);
        vm.recordLogs();
        vm.prank(attacker);
        drainer.drain(address(_token(c, k)), hot);
        _deliver(address(tw), c, vm.getRecordedLogs());
    }

    function act_intend(uint256 seed_, uint256 amount_, uint64 ttl_, bool toShop_) external tracked(false) {
        ++calls;
        (uint256 c, uint256 k) = _pick(seed_);
        ttl_ = uint64(bound(ttl_, 1, 1 days));
        _intend(c, cosigner, k, toShop_ ? shop : attacker, bound(amount_, 0, START), ttl_);
    }

    function act_panic(uint256 seed_, bool byCosigner_) external tracked(byCosigner_) {
        ++calls;
        (uint256 c,) = _pick(seed_);
        _panic(c, byCosigner_ ? cosigner : hot);
    }

    function act_relay() external tracked(false) {
        ++calls;
        _relayAndEcho();
    }

    function act_mint(uint256 seed_, uint256 amount_) external tracked(false) {
        ++calls;
        (uint256 c, uint256 k) = _pick(seed_);
        _token(c, k).mint(hot, bound(amount_, 1, START));
    }

    function act_warp(uint32 dt_) external tracked(false) {
        ++calls;
        vm.warp(block.timestamp + bound(dt_, 1, 2 days));
    }

    /// Re-delivers an already delivered callback through the real path. Must move nothing.
    function act_replay(uint256 idx_) external tracked(false) {
        ++calls;
        if (relayed == 0) return;
        MockSystem.Req memory r = sys.request(idx_ % relayed);
        uint256 before = _coldTotal();
        proxyOf[r.chainId].deliver(r.recipient, r.sender, r.gasLimit, r.payload);
        if (_coldTotal() != before) replayMoved = true;
    }

    /// Anyone calling a Guardian directly, claiming any sender.
    function act_forgeDirect(uint256 seed_, address caller_, address claimed_, uint256 tripId_)
        external
        tracked(false)
    {
        ++calls;
        (uint256 c,) = _pick(seed_);
        address[] memory list = tw.tokens(c);
        vm.prank(caller_);
        try chains[c].guardian.sweep(claimed_, tripId_, list) {
            if (caller_ != address(chains[c].proxy) || claimed_ != address(tw)) ++forgedSweeps;
        } catch {}
    }

    /// Another reactive contract driving the real proxy.
    function act_forgeViaProxy(uint256 seed_, address sender_, uint256 tripId_) external tracked(false) {
        ++calls;
        if (sender_ == address(tw)) return;
        (uint256 c,) = _pick(seed_);
        (bool ok,) = chains[c].proxy
            .deliver(
                address(chains[c].guardian),
                sender_,
                2_000_000,
                abi.encodeCall(Guardian.sweep, (address(0), tripId_, tw.tokens(c)))
            );
        if (ok) ++forgedSweeps;
    }
}

contract TripwireInvariantTest is StdInvariant, Test {
    TripwireHandler internal h;

    function setUp() public {
        h = new TripwireHandler();
        vm.deal(address(h), 10 ether);
        h.setUp();
        bytes4[] memory sel = new bytes4[](11);
        sel[0] = TripwireHandler.act_hotTransfer.selector;
        sel[1] = TripwireHandler.act_hotApprove.selector;
        sel[2] = TripwireHandler.act_drain.selector;
        sel[3] = TripwireHandler.act_intend.selector;
        sel[4] = TripwireHandler.act_panic.selector;
        sel[5] = TripwireHandler.act_relay.selector;
        sel[6] = TripwireHandler.act_mint.selector;
        sel[7] = TripwireHandler.act_warp.selector;
        sel[8] = TripwireHandler.act_replay.selector;
        sel[9] = TripwireHandler.act_forgeDirect.selector;
        sel[10] = TripwireHandler.act_forgeViaProxy.selector;
        targetSelector(FuzzSelector({addr: address(h), selectors: sel}));
        targetContract(address(h));
    }

    function _each(function(uint256, SpyERC20, Guardian) view check_) internal view {
        for (uint256 i; i < 3; ++i) {
            uint256 c = h.chainIdAt(i);
            for (uint256 k; k < 3; ++k) {
                check_(c, h.tokenAt(c, k), h.guardianOf(c));
            }
        }
    }

    /// The Guardian has only ever sent tokens to COLD.
    function invariant_guardianOnlyPaysCold() public view {
        _each(_onlyCold);
    }

    function _onlyCold(uint256, SpyERC20 t_, Guardian g_) internal view {
        address first = t_.firstRecipient(address(g_));
        assertTrue(first == address(0) || first == h.coldAddr(), "guardian paid someone else");
        assertFalse(t_.mixedRecipients(address(g_)), "guardian paid two recipients");
    }

    /// The Guardian never holds tokens.
    function invariant_guardianHoldsNothing() public view {
        _each(_holdsNothing);
    }

    function _holdsNothing(uint256, SpyERC20 t_, Guardian g_) internal view {
        assertEq(t_.balanceOf(address(g_)), 0);
    }

    /// Every token in COLD came from a Guardian sweep or a deliberate hot -> cold transfer.
    function invariant_coldIsExplained() public view {
        _each(_explained);
    }

    function _explained(uint256 c_, SpyERC20 t_, Guardian g_) internal view {
        uint256 k;
        for (; k < 3; ++k) {
            if (address(h.tokenAt(c_, k)) == address(t_)) break;
        }
        assertEq(t_.balanceOf(h.coldAddr()), t_.pulled(address(g_), h.coldAddr()) + h.hotToCold(c_, k));
    }

    /// Only the proxy carrying the right reactive id can sweep.
    function invariant_noForgedSweep() public view {
        assertEq(h.forgedSweeps(), 0);
    }

    /// Coverage check with -vv: shows the runs really trip and sweep.
    function afterInvariant() public view {
        console.log("trips=%d coldTotal=%d", h.tripCount(), h.coldTotal());
    }

    /// Re-delivering a handled callback moves nothing.
    function invariant_replayIsNoOp() public view {
        assertFalse(h.replayMoved());
    }

    /// Repeated untrusted moves can't make it request sweeps faster than once per merge window (cosigner panic aside).
    function invariant_tripsRespectWindow() public view {
        assertEq(h.windowViolations(), 0);
    }
}
