// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Test.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {OmniSim} from "./OmniSim.sol";
import {MockCallbackProxy} from "../mocks/MockCallbackProxy.sol";
import {MockSystem} from "../mocks/MockSystem.sol";
import {SpyERC20} from "../mocks/WeirdTokens.sol";
import {Guardian} from "../../src/Guardian.sol";
import {TripwireReactive} from "../../src/TripwireReactive.sol";
import {Intent} from "../../src/Intent.sol";
import {PanicButton} from "../../src/PanicButton.sol";

/// @notice Three simulated chains (Base, Ethereum and Unichain Sepolia ids), three tokens each, a Guardian per chain
///         and one TripwireReactive, wired the way the deploy scripts wire them.
abstract contract Fixture is OmniSim {
    uint256 internal constant BASE = 84532;
    uint256 internal constant ETH = 11155111;
    uint256 internal constant UNI = 1301;
    uint256 internal constant TOKENS = 3;
    uint256 internal constant START = 1_000e18;

    struct Net {
        uint256 id;
        MockCallbackProxy proxy;
        SpyERC20[] tokens;
        Intent intent;
        PanicButton panic;
        Guardian guardian;
    }

    address internal hot = makeAddr("hot");
    address internal cold = makeAddr("cold");
    address internal cosigner = makeAddr("cosigner");
    address internal attacker = makeAddr("attacker");
    address internal shop = makeAddr("shop");

    TripwireReactive internal tw;
    uint256[] internal ids;
    mapping(uint256 chainId => Net) internal chains;

    function setUp() public virtual {
        _installSystem();
        ids = [BASE, ETH, UNI];

        address[] memory intents = new address[](3);
        address[] memory panics = new address[](3);
        for (uint256 i; i < 3; ++i) {
            Net storage c = chains[ids[i]];
            c.id = ids[i];
            c.proxy = new MockCallbackProxy();
            proxyOf[ids[i]] = c.proxy;
            c.intent = new Intent();
            c.panic = new PanicButton();
            intents[i] = address(c.intent);
            panics[i] = address(c.panic);
            for (uint256 k; k < TOKENS; ++k) {
                c.tokens.push(new SpyERC20(string.concat("Token", vm.toString(k)), string.concat("T", vm.toString(k))));
            }
        }

        // 1. Reactive contract first (it needs the signal contracts, not the guardians).
        tw = new TripwireReactive{value: 1 ether}(hot, cold, cosigner, ids, intents, panics);

        // 2. Guardians with the reactive address, 3. wire them back, 4. register tokens, 5. hot approves.
        for (uint256 i; i < 3; ++i) {
            Net storage c = chains[ids[i]];
            c.guardian = new Guardian(IPayable(payable(address(c.proxy))), address(tw), hot, cold);
            c.proxy.depositTo{value: 0.1 ether}(address(c.guardian));
            tw.setGuardian(c.id, address(c.guardian));
            for (uint256 k; k < TOKENS; ++k) {
                SpyERC20 t = c.tokens[k];
                tw.addToken(c.id, address(t), 0);
                t.mint(hot, START);
                vm.prank(hot);
                t.approve(address(c.guardian), type(uint256).max);
            }
        }
    }

    // ------------------------------------------------------------ origin-side actions, delivered through the sim

    function _token(uint256 chainId_, uint256 k_) internal view returns (SpyERC20) {
        return chains[chainId_].tokens[k_];
    }

    function _hotTransfer(uint256 chainId_, uint256 k_, address to_, uint256 amount_) internal {
        vm.recordLogs();
        vm.prank(hot);
        _token(chainId_, k_).transfer(to_, amount_);
        _deliver(address(tw), chainId_, vm.getRecordedLogs());
    }

    function _hotApprove(uint256 chainId_, uint256 k_, address spender_, uint256 amount_) internal {
        vm.recordLogs();
        vm.prank(hot);
        _token(chainId_, k_).approve(spender_, amount_);
        _deliver(address(tw), chainId_, vm.getRecordedLogs());
    }

    function _intend(uint256 chainId_, address signer_, uint256 k_, address to_, uint256 amount_, uint64 ttl_)
        internal
    {
        vm.recordLogs();
        vm.prank(signer_);
        chains[chainId_].intent.intendFor(address(_token(chainId_, k_)), to_, amount_, ttl_);
        _deliver(address(tw), chainId_, vm.getRecordedLogs());
    }

    function _panic(uint256 chainId_, address who_) internal {
        vm.recordLogs();
        vm.prank(who_);
        chains[chainId_].panic.panic();
        _deliver(address(tw), chainId_, vm.getRecordedLogs());
    }

    /// @dev Relays pending callbacks and feeds the sweeps' own logs back in, as the live network would. Returns how
    ///      many callbacks failed. Bounded, so a feedback loop shows up as a failure instead of a hang.
    function _relayAndEcho() internal returns (uint256 failed_) {
        for (uint256 guard; relayed < sys.requestCount(); ++guard) {
            require(guard < 64, "callback feedback loop");
            MockSystem.Req memory r = sys.request(relayed);
            ++relayed;
            vm.recordLogs();
            (bool ok,) = proxyOf[r.chainId].deliver(r.recipient, r.sender, r.gasLimit, r.payload);
            if (!ok) ++failed_;
            _deliver(address(tw), r.chainId, vm.getRecordedLogs());
        }
    }

    function _sweepable(uint256 chainId_) internal view returns (uint256 total_) {
        for (uint256 k; k < TOKENS; ++k) {
            total_ += chains[chainId_].guardian.sweepable(address(_token(chainId_, k)));
        }
    }

    function _coldTotal() internal view returns (uint256 total_) {
        for (uint256 i; i < ids.length; ++i) {
            for (uint256 k; k < TOKENS; ++k) {
                total_ += _token(ids[i], k).balanceOf(cold);
            }
        }
    }
}
