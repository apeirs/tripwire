// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test} from "forge-std/Test.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {AbstractPayer} from "@reactive/src/base/AbstractPayer.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";
import {Guardian} from "../src/Guardian.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockCallbackProxy} from "./mocks/MockCallbackProxy.sol";
import {
    SpyERC20,
    NoReturnERC20,
    FalseReturnERC20,
    RevertingERC20,
    GasBurnerERC20,
    ReturnBombERC20,
    ReentrantERC20
} from "./mocks/WeirdTokens.sol";

contract GuardianTest is Test {
    uint64 internal constant GAS = 2_000_000;

    MockCallbackProxy internal proxy;
    Guardian internal g;
    SpyERC20 internal a;
    SpyERC20 internal b;

    address internal tripwire = makeAddr("tripwire");
    address internal hot = makeAddr("hot");
    address internal cold = makeAddr("cold");

    event Swept(uint256 indexed tripId, address indexed token, uint256 amount);
    event Skipped(uint256 indexed tripId, address indexed token, Guardian.SkipReason reason);
    event Replayed(uint256 indexed tripId);

    function setUp() public {
        proxy = new MockCallbackProxy();
        g = new Guardian(IPayable(payable(address(proxy))), tripwire, hot, cold);
        a = new SpyERC20("A", "A");
        b = new SpyERC20("B", "B");
        a.mint(hot, 100e18);
        b.mint(hot, 50e18);
        vm.startPrank(hot);
        a.approve(address(g), type(uint256).max);
        b.approve(address(g), type(uint256).max);
        vm.stopPrank();
    }

    function _list(address x_) internal pure returns (address[] memory l_) {
        l_ = new address[](1);
        l_[0] = x_;
    }

    function _list(address x_, address y_) internal pure returns (address[] memory l_) {
        l_ = new address[](2);
        l_[0] = x_;
        l_[1] = y_;
    }

    function _payload(uint256 tripId_, address[] memory tokens_) internal pure returns (bytes memory) {
        return abi.encodeCall(Guardian.sweep, (address(0), tripId_, tokens_));
    }

    function _viaProxy(uint256 tripId_, address[] memory tokens_) internal returns (bool ok_) {
        (ok_,) = proxy.deliver(address(g), tripwire, GAS, _payload(tripId_, tokens_));
    }

    // ------------------------------------------------------------ construction

    function test_constructor_setsImmutables() public view {
        assertEq(g.HOT(), hot);
        assertEq(g.COLD(), cold);
        assertEq(g._CALLBACK_SENDER(), tripwire);
        assertEq(address(g._SERVICE_PROVIDER()), address(proxy));
    }

    function test_constructor_rejectsZeroAndSame() public {
        IPayable p = IPayable(payable(address(proxy)));
        vm.expectRevert(Guardian.ZeroAddress.selector);
        new Guardian(IPayable(payable(address(0))), tripwire, hot, cold);
        vm.expectRevert(Guardian.ZeroAddress.selector);
        new Guardian(p, address(0), hot, cold);
        vm.expectRevert(Guardian.ZeroAddress.selector);
        new Guardian(p, tripwire, address(0), cold);
        vm.expectRevert(Guardian.ZeroAddress.selector);
        new Guardian(p, tripwire, hot, address(0));
        vm.expectRevert(Guardian.HotIsCold.selector);
        new Guardian(p, tripwire, hot, hot);
    }

    // ------------------------------------------------------------ the happy path

    function test_sweep_movesEverythingToCold() public {
        vm.expectEmit(address(g));
        emit Swept(1, address(a), 100e18);
        vm.expectEmit(address(g));
        emit Swept(1, address(b), 50e18);
        assertTrue(_viaProxy(1, _list(address(a), address(b))));
        assertEq(a.balanceOf(cold), 100e18);
        assertEq(b.balanceOf(cold), 50e18);
        assertEq(a.balanceOf(hot), 0);
        assertTrue(g.handled(1));
    }

    function testFuzz_sweep_movesMinOfBalanceAndAllowance(uint256 bal_, uint256 allow_) public {
        bal_ = bound(bal_, 0, 1e30);
        MockERC20 t = new MockERC20("F", "F", 6);
        t.mint(hot, bal_);
        vm.prank(hot);
        t.approve(address(g), allow_);

        uint256 expected = bal_ < allow_ ? bal_ : allow_;
        assertEq(g.sweepable(address(t)), expected);
        assertTrue(_viaProxy(7, _list(address(t))));
        assertEq(t.balanceOf(cold), expected);
        assertEq(t.balanceOf(hot), bal_ - expected);
        assertEq(t.balanceOf(address(g)), 0);
    }

    // ------------------------------------------------------------ authorisation

    function testFuzz_sweep_rejectsAnyDirectCaller(address caller_, address claimed_) public {
        vm.assume(caller_ != address(proxy));
        vm.prank(caller_);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, caller_, address(proxy)));
        g.sweep(claimed_, 1, _list(address(a)));
        assertEq(a.balanceOf(cold), 0);
    }

    function testFuzz_sweep_rejectsWrongReactiveViaProxy(address sender_) public {
        vm.assume(sender_ != tripwire);
        (bool ok,) = proxy.deliver(address(g), sender_, GAS, _payload(1, _list(address(a))));
        assertFalse(ok);
        assertEq(a.balanceOf(cold), 0);
        assertFalse(g.handled(1));

        // and the direct form of the same call names the reason
        vm.prank(address(proxy));
        vm.expectRevert(abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, sender_, tripwire));
        g.sweep(sender_, 1, _list(address(a)));
    }

    function test_sweep_placeholderIsOverwrittenByProxy() public {
        // The reactive side always sends address(0); only the proxy's injection makes it valid.
        vm.prank(address(proxy));
        vm.expectRevert(abi.encodeWithSelector(AbstractCallback.CallbackNotAuthorized.selector, address(0), tripwire));
        g.sweep(address(0), 1, _list(address(a)));
    }

    // ------------------------------------------------------------ replays and repeats

    function test_replay_isNoOpEvenWithNewFunds() public {
        assertTrue(_viaProxy(1, _list(address(a))));
        a.mint(hot, 5e18);
        vm.expectEmit(address(g));
        emit Replayed(1);
        assertTrue(_viaProxy(1, _list(address(a))));
        assertEq(a.balanceOf(hot), 5e18, "replay must not move funds");
        assertEq(a.balanceOf(cold), 100e18);
    }

    function testFuzz_secondTripOnSameState_movesNothing(uint256 id1_, uint256 id2_) public {
        vm.assume(id1_ != id2_);
        assertTrue(_viaProxy(id1_, _list(address(a), address(b))));
        uint256 coldA = a.balanceOf(cold);
        vm.expectEmit(address(g));
        emit Skipped(id2_, address(a), Guardian.SkipReason.NothingToMove);
        assertTrue(_viaProxy(id2_, _list(address(a), address(b))));
        assertEq(a.balanceOf(cold), coldA);
    }

    // ------------------------------------------------------------ hostile and broken tokens

    function test_weirdTokens_skippedOthersStillSwept() public {
        NoReturnERC20 usdt = new NoReturnERC20();
        FalseReturnERC20 f = new FalseReturnERC20();
        RevertingERC20 r = new RevertingERC20();
        GasBurnerERC20 burn = new GasBurnerERC20();
        ReturnBombERC20 bomb = new ReturnBombERC20();
        usdt.mint(hot, 7e6);
        f.mint(hot, 1e18);
        r.mint(hot, 1e18);
        vm.startPrank(hot);
        usdt.approve(address(g), type(uint256).max);
        f.approve(address(g), type(uint256).max);
        r.approve(address(g), type(uint256).max);
        vm.stopPrank();

        address[] memory list = new address[](8);
        list[0] = address(f);
        list[1] = address(r);
        list[2] = address(burn);
        list[3] = address(bomb);
        list[4] = makeAddr("eoa");
        list[5] = address(usdt);
        list[6] = address(a);
        list[7] = address(b);

        vm.expectEmit(address(g));
        emit Skipped(3, address(f), Guardian.SkipReason.TransferFailed);
        vm.expectEmit(address(g));
        emit Skipped(3, address(r), Guardian.SkipReason.TransferFailed);
        vm.expectEmit(address(g));
        emit Skipped(3, address(burn), Guardian.SkipReason.ReadFailed);
        vm.expectEmit(address(g));
        emit Skipped(3, address(bomb), Guardian.SkipReason.ReadFailed);
        vm.expectEmit(address(g));
        emit Skipped(3, makeAddr("eoa"), Guardian.SkipReason.NotAContract);
        (bool ok,) = proxy.deliver(address(g), tripwire, 3_000_000, _payload(3, list));
        assertTrue(ok);
        assertEq(usdt.balanceOf(cold), 7e6, "no-return token swept");
        assertEq(a.balanceOf(cold), 100e18);
        assertEq(b.balanceOf(cold), 50e18);
        assertEq(f.balanceOf(hot), 1e18);
    }

    function test_reentrancy_cannotSweepAgain() public {
        ReentrantERC20 t = new ReentrantERC20();
        t.setTarget(address(g));
        t.mint(hot, 1e18);
        vm.prank(hot);
        t.approve(address(g), type(uint256).max);
        assertTrue(_viaProxy(1, _list(address(t))));
        assertTrue(t.reentered());
        assertFalse(t.reentrySucceeded());
        assertFalse(g.handled(999));
        assertEq(t.balanceOf(cold), 1e18);
    }

    function test_tooManyTokens_capped() public {
        address[] memory list = new address[](40);
        for (uint256 i; i < 40; ++i) {
            list[i] = address(a);
        }
        (bool ok,) = proxy.deliver(address(g), tripwire, 30_000_000, _payload(1, list));
        assertTrue(ok);
        assertEq(a.balanceOf(cold), 100e18);
    }

    function test_lowGas_skipsTailButNeverRevertsMovedTokens() public {
        // Enough for the first token's reserve, not for the second.
        (bool ok,) = proxy.deliver(address(g), tripwire, 200_000 + 420_000, _payload(1, _list(address(a), address(b))));
        assertTrue(ok, "sweep must not revert on low gas");
        assertEq(a.balanceOf(cold), 100e18, "first token kept");
        assertEq(b.balanceOf(cold), 0, "second skipped");
        assertTrue(g.handled(1));
    }

    // ------------------------------------------------------------ only COLD

    function testFuzz_onlyColdEverReceives(address hot_, address cold_, uint96 amount_, uint256 tripId_) public {
        vm.assume(hot_ != address(0) && cold_ != address(0) && hot_ != cold_);
        Guardian g2 = new Guardian(IPayable(payable(address(proxy))), tripwire, hot_, cold_);
        SpyERC20 t = new SpyERC20("S", "S");
        t.mint(hot_, amount_);
        vm.prank(hot_);
        t.approve(address(g2), type(uint256).max);

        (bool ok,) = proxy.deliver(
            address(g2), tripwire, GAS, abi.encodeCall(Guardian.sweep, (address(0), tripId_, _list(address(t))))
        );
        assertTrue(ok);
        if (amount_ > 0) assertEq(t.firstRecipient(address(g2)), cold_);
        assertFalse(t.mixedRecipients(address(g2)));
        assertEq(t.pulled(address(g2), cold_), amount_);
        assertEq(t.balanceOf(address(g2)), 0);
    }

    // ------------------------------------------------------------ payments

    function test_pay_onlyProxy() public {
        vm.deal(address(g), 1 ether);
        vm.expectRevert(abi.encodeWithSelector(AbstractPayer.NotAuthorized.selector, address(this), address(proxy)));
        g.pay(1);

        uint256 before = address(proxy).balance;
        proxy.charge(address(g), 0.25 ether);
        assertEq(address(proxy).balance - before, 0.25 ether);
        assertEq(address(g).balance, 0.75 ether);
    }
}
