// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {console} from "forge-std/Test.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {Fixture} from "./utils/Fixture.sol";
import {MockSystem} from "./mocks/MockSystem.sol";
import {SpyERC20} from "./mocks/WeirdTokens.sol";
import {SpendApprovalERC20} from "./mocks/WeirdTokens.sol";
import {Guardian} from "../src/Guardian.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {Drainer} from "../src/mocks/Drainer.sol";

/// @notice Whole-loop scenarios: origin event -> react() -> callbacks -> sweeps on all three chains, with the sweeps'
///         own logs fed back in.
contract LoopTest is Fixture {
    Drainer internal drainer;

    function setUp() public override {
        super.setUp();
        vm.prank(attacker);
        drainer = new Drainer();
    }

    function _everythingHome() internal view {
        for (uint256 i; i < ids.length; ++i) {
            assertEq(_sweepable(ids[i]), 0, "nothing left to sweep");
        }
    }

    /// Scenario 1: approval drainer pulls one token per transaction on Base.
    function test_scenario_allowanceDrain() public {
        // The victim signs a phishing approval. That alone trips Tripwire (unknown spender).
        _hotApprove(BASE, 0, address(drainer), type(uint256).max);
        assertEq(tw.trips(), 1);
        assertEq(_relayAndEcho(), 0);

        // By the time the drainer pulls, everything approved to the Guardians is already home.
        vm.prank(attacker);
        uint256 got = drainer.drain(address(_token(BASE, 0)), hot);
        assertEq(got, 0, "drainer gets nothing");
        assertEq(_coldTotal(), 3 * TOKENS * START);
        _everythingHome();
        assertEq(tw.trips(), 1, "sweeps don't re-trip");
    }

    /// Scenario 1b: the approval is trusted (or arrives with the pull in one tx), so the first pull lands; the rest
    /// of the wallet on all chains is saved.
    function test_scenario_firstPullLands_restSaved() public {
        tw.setTrusted(address(drainer), true); // worst case: the approval itself doesn't trip
        _hotApprove(BASE, 0, address(drainer), type(uint256).max);
        assertEq(tw.trips(), 0);

        vm.recordLogs();
        vm.prank(attacker);
        drainer.drain(address(_token(BASE, 0)), hot);
        _deliver(address(tw), BASE, vm.getRecordedLogs());
        // drained to the attacker (the operator), not the trusted drainer contract itself
        assertEq(tw.trips(), 1);
        assertEq(_relayAndEcho(), 0);

        assertEq(_token(BASE, 0).balanceOf(attacker), START, "first token lost");
        assertEq(_coldTotal(), (3 * TOKENS - 1) * START, "everything else saved");
        _everythingHome();
    }

    /// Scenario 2: a key sweeper empties token by token, starting on Unichain.
    function test_scenario_keySweeperStartsOnUnichain() public {
        _hotTransfer(UNI, 2, attacker, START);
        assertEq(_relayAndEcho(), 0);
        assertEq(_coldTotal(), (3 * TOKENS - 1) * START);

        // the sweeper's next transfers find nothing
        vm.prank(hot);
        vm.expectRevert(MockERC20.InsufficientBalance.selector);
        _token(BASE, 0).transfer(attacker, 1);
    }

    /// Scenario 3: manual panic from the cosigner's phone wallet on Ethereum Sepolia.
    function test_scenario_panic() public {
        _panic(ETH, cosigner);
        assertEq(_relayAndEcho(), 0);
        assertEq(_coldTotal(), 3 * TOKENS * START);
    }

    /// Scenario 4: a legitimate payment with an intent doesn't trip, and nothing moves.
    function test_scenario_intendedPayment() public {
        _intend(BASE, cosigner, 1, shop, 25e18, 15 minutes);
        _hotTransfer(BASE, 1, shop, 25e18);
        assertEq(tw.trips(), 0);
        assertEq(sys.requestCount(), 0);
        assertEq(_coldTotal(), 0);
        assertEq(_token(BASE, 1).balanceOf(shop), 25e18);
    }

    /// The thief revokes the Guardian first: that revoke is itself the trip, on every other chain too.
    function test_scenario_revokeGuardianFirst() public {
        _hotApprove(ETH, 0, address(chains[ETH].guardian), 0);
        assertEq(_relayAndEcho(), 0);
        // token 0 on ETH was un-approved, so it stays; everything else is home
        assertEq(_coldTotal(), (3 * TOKENS - 1) * START);
        assertEq(_token(ETH, 0).balanceOf(hot), START);
    }

    /// Tokens that spend allowances with a fresh Approval (OpenZeppelin v4 style) and finite approvals: the
    /// Guardian's own sweep emits Approval(hot, guardian, lower); the loop must settle, not ping-pong forever.
    function test_finiteApproval_spendingToken_loopSettles() public {
        SpendApprovalERC20 t = new SpendApprovalERC20();
        tw.addToken(BASE, address(t), 0);
        t.mint(hot, 100e18);
        vm.prank(hot);
        t.approve(address(chains[BASE].guardian), 60e18); // finite (set up directly, not fed to the sim)

        _hotTransfer(BASE, 0, attacker, 1e18);
        assertEq(_relayAndEcho(), 0);
        assertEq(t.balanceOf(cold), 60e18);
        assertLe(tw.trips(), 3, "bounded re-trips");
    }

    // ------------------------------------------------------------ gas

    /// Sweep gas through the proxy for N standard tokens stays inside the requested callback gas limit, with no
    /// token skipped for gas. Numbers are logged for the README.
    function test_gasBudget_perTokenCount() public {
        uint256[5] memory counts = [uint256(1), 3, 4, 8, 16];
        for (uint256 c; c < counts.length; ++c) {
            uint256 n = counts[c];
            MockERC20[] memory list = new MockERC20[](n);
            address[] memory addrs = new address[](n);
            for (uint256 i; i < n; ++i) {
                list[i] = new MockERC20("G", "G", 18);
                list[i].mint(hot, 1e18);
                vm.prank(hot);
                list[i].approve(address(chains[BASE].guardian), type(uint256).max);
                addrs[i] = address(list[i]);
                vm.cool(addrs[i]);
            }
            vm.cool(address(chains[BASE].guardian));
            uint64 limit = tw.callbackGasLimit(n);
            (bool ok, uint256 used) = chains[BASE].proxy
                .deliver(
                    address(chains[BASE].guardian),
                    address(tw),
                    limit,
                    abi.encodeCall(Guardian.sweep, (address(0), 1000 + c, addrs))
                );
            assertTrue(ok, "sweep failed");
            for (uint256 i; i < n; ++i) {
                assertEq(list[i].balanceOf(cold), 1e18, "token skipped");
            }
            console.log("sweep tokens=%d gasUsed=%d limit=%d", n, used, limit);
            // stated budget: 45k base + 40k per token (cold accounts, standard ERC-20)
            assertLe(used, 45_000 + 40_000 * n, "over stated budget");
        }
    }

    /// react() gas for a trip over 3 chains x 3 tokens, with the system contract mocked lean (emit only).
    function test_gas_reactTrip() public {
        vm.recordLogs();
        vm.prank(hot);
        _token(BASE, 0).transfer(attacker, 1e18);
        IReactive.LogRecord memory rec = _record(BASE, vm.getRecordedLogs()[0], 1, 0);
        sys.setLean(true);
        vm.prank(SYSTEM_ADDR);
        uint256 g0 = gasleft();
        tw.react(rec);
        uint256 used = g0 - gasleft();
        assertEq(tw.trips(), 1);
        console.log("react() trip, 3 chains x 3 tokens: gas %d", used);
        assertLe(used, 250_000, "react trip over budget");

        // a cleared transfer (COLD) is the cheap path
        rec.topic2 = uint256(uint160(cold));
        rec.logIndex = 1;
        vm.prank(SYSTEM_ADDR);
        g0 = gasleft();
        tw.react(rec);
        console.log("react() cleared transfer: gas %d", g0 - gasleft());

        // an untrusted move in a later transaction, inside the merge window: recorded, no callbacks
        rec.topic2 = uint256(uint160(attacker));
        rec.txHash = 2;
        vm.prank(SYSTEM_ADDR);
        g0 = gasleft();
        tw.react(rec);
        used = g0 - gasleft();
        assertEq(tw.trips(), 1);
        console.log("react() merged trip: gas %d", used);
        assertLe(used, 60_000, "merged trip over budget");
    }
}
