// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {TripwireReactive} from "../src/TripwireReactive.sol";
import {Chains} from "./Chains.sol";

/// @notice Reactive Network, step 4, once per protected chain: point it at its Guardian and register the tokens.
/// Env: PRIVATE_KEY (owner), TRIPWIRE, CHAIN_ID, GUARDIAN, TOKENS (comma list), THRESHOLDS (optional comma list,
///      raw units, default 0), TRUSTED (optional comma list of recipients/spenders that never trip).
contract Configure is Script {
    function run() external {
        require(Chains.isReactive(block.chainid), "run this on Reactive Network");
        TripwireReactive tw = TripwireReactive(payable(vm.envAddress("TRIPWIRE")));
        uint256 chainId = vm.envUint("CHAIN_ID");
        address[] memory tokens = vm.envAddress("TOKENS", ",");
        uint256[] memory thresholds = vm.envOr("THRESHOLDS", ",", new uint256[](0));
        address[] memory trusted = vm.envOr("TRUSTED", ",", new address[](0));
        require(thresholds.length == 0 || thresholds.length == tokens.length, "THRESHOLDS length");

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        tw.setGuardian(chainId, vm.envAddress("GUARDIAN"));
        for (uint256 i; i < tokens.length; ++i) {
            if (!tw.watched(chainId, tokens[i])) {
                tw.addToken(chainId, tokens[i], thresholds.length == 0 ? 0 : thresholds[i]);
            }
        }
        for (uint256 i; i < trusted.length; ++i) {
            tw.setTrusted(trusted[i], true);
        }
        vm.stopBroadcast();
        console.log("chain %d configured with %d tokens", chainId, tw.tokens(chainId).length);
    }
}
