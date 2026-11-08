// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Fixture} from "./utils/Fixture.sol";
import {FiatTokenLike} from "./mocks/WeirdTokens.sol";
import {Guardian} from "../src/Guardian.sol";
import {TripwireReactive} from "../src/TripwireReactive.sol";

/// @notice A real 6-decimal asset (USDC-like) guarded next to the 18-decimal test tokens, through the whole loop.
contract UsdcTest is Fixture {
    uint256 internal constant ONE_USDC = 1e6;
    uint256 internal constant HELD = 20 * ONE_USDC; // one Circle faucet drip

    FiatTokenLike internal usdc;
    Guardian internal g;

    event Skipped(uint256 indexed tripId, address indexed token, Guardian.SkipReason reason);

    function setUp() public override {
        super.setUp();
        g = chains[BASE].guardian;
        usdc = new FiatTokenLike();
        tw.addToken(BASE, address(usdc), 5 * ONE_USDC); // threshold in raw units: 5 USDC
        usdc.mint(hot, HELD);
        _hotApproveUsdc(address(g), type(uint256).max); // fed through the loop: arming must not trip
        assertEq(tw.trips(), 0, "arming the Guardian is trusted");
    }

    function _hotApproveUsdc(address spender_, uint256 amount_) internal {
        vm.recordLogs();
        vm.prank(hot);
        usdc.approve(spender_, amount_);
        _deliver(address(tw), BASE, vm.getRecordedLogs());
    }

    function _hotSendUsdc(address to_, uint256 amount_) internal {
        vm.recordLogs();
        vm.prank(hot);
        usdc.transfer(to_, amount_);
        _deliver(address(tw), BASE, vm.getRecordedLogs());
    }

    function test_usdc_thresholdInRawUnits() public {
        _hotSendUsdc(shop, 5 * ONE_USDC); // exactly the threshold: cleared
        assertEq(tw.trips(), 0);
        _hotSendUsdc(shop, 5 * ONE_USDC + 1); // one micro-USDC over: trips
        assertEq(tw.trips(), 1);
    }

    /// The whole loop with a 6-decimal and three 18-decimal tokens: everything left on HOT goes to COLD, at its own
    /// precision, and the sweep's own logs settle (no second trip).
    function test_usdc_sweptAlongsideTestTokens_loopSettles() public {
        _hotSendUsdc(attacker, 6 * ONE_USDC);
        assertEq(tw.trips(), 1);
        assertEq(_relayAndEcho(), 0);

        assertEq(usdc.balanceOf(cold), HELD - 6 * ONE_USDC, "USDC left on HOT swept, to the micro-unit");
        assertEq(usdc.balanceOf(hot), 0);
        assertEq(_token(BASE, 0).balanceOf(cold), START, "18-decimal tokens swept in the same callback");
        assertEq(tw.trips(), 1, "sweeps don't re-trip");
    }

    /// FiatToken spends even a max allowance (no infinite-approval shortcut) and emits no Approval for it. The
    /// Guardian stays far above the revoke floor, so it stays armed, and a later trip sweeps new funds again.
    function test_usdc_allowanceSpentDown_staysArmed() public {
        _hotSendUsdc(attacker, 6 * ONE_USDC);
        assertEq(_relayAndEcho(), 0);
        uint256 left = usdc.allowance(hot, address(g));
        assertEq(left, type(uint256).max - (HELD - 6 * ONE_USDC), "allowance spent down by the sweep");
        assertGe(left, tw.GUARDIAN_ALLOWANCE_FLOOR(), "still armed");

        usdc.mint(hot, HELD); // a faucet top-up later
        vm.warp(block.timestamp + tw.tripCooldown());
        _hotSendUsdc(attacker, 6 * ONE_USDC);
        assertEq(tw.trips(), 2);
        assertEq(_relayAndEcho(), 0);
        assertEq(usdc.balanceOf(cold), 2 * (HELD - 6 * ONE_USDC));
    }

    /// Circle pauses the token, or blacklists the vault: USDC is skipped with a reason, the rest still moves.
    function test_usdc_pausedOrBlacklisted_skippedOthersSwept() public {
        usdc.setPaused(true);
        _panic(ETH, cosigner);
        vm.expectEmit(true, true, true, true, address(g));
        emit Skipped(1, address(usdc), Guardian.SkipReason.TransferFailed);
        assertEq(_relayAndEcho(), 0);
        assertEq(usdc.balanceOf(hot), HELD, "paused USDC stays");
        assertEq(_coldTotal(), 3 * TOKENS * START, "everything else swept");

        usdc.setPaused(false);
        usdc.blacklist(cold, true);
        _panic(ETH, cosigner); // the cosigner's panic always fires
        assertEq(_relayAndEcho(), 0);
        assertEq(usdc.balanceOf(hot), HELD, "blacklisted vault: USDC stays, nothing sent elsewhere");
        assertEq(usdc.balanceOf(cold), 0);
    }

    /// The Guardian's sweep of a FiatToken-like token stays well inside the per-token call cap.
    function test_usdc_sweepGasUnderTokenCap() public {
        vm.prank(address(chains[BASE].proxy));
        address[] memory list = new address[](1);
        list[0] = address(usdc);
        uint256 g0 = gasleft();
        g.sweep(address(tw), 99, list);
        uint256 used = g0 - gasleft();
        assertEq(usdc.balanceOf(cold), HELD);
        assertLt(used, g.MIN_GAS_PER_TOKEN(), "one token fits the per-token reserve");
    }
}
