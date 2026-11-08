// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {TripwireReactive} from "../src/TripwireReactive.sol";
import {Chains} from "./Chains.sol";
import {Tokens} from "./Tokens.sol";

/// @notice Reactive Network, step 4, once per protected chain: point it at its Guardian and register the tokens.
///         Safe to re-run: tokens already watched keep their subscriptions and only get their threshold updated.
/// Env: PRIVATE_KEY (owner), TRIPWIRE, CHAIN_ID, GUARDIAN, the token list (see Tokens.sol: TOKENS, THRESHOLDS,
///      USDC=true for Circle's USDC, USDC_THRESHOLD), TRUSTED (optional comma list of recipients/spenders
///      that never trip).
contract Configure is Script {
    function run() external {
        require(Chains.isReactive(block.chainid), "run this on Reactive Network");
        TripwireReactive tw = TripwireReactive(payable(vm.envAddress("TRIPWIRE")));
        uint256 chainId = vm.envUint("CHAIN_ID");
        Chains.requireSameNetwork(block.chainid, chainId);
        (address[] memory tokens, uint256[] memory thresholds) = Tokens.list(chainId);
        address[] memory trusted = vm.envOr("TRUSTED", ",", new address[](0));

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        tw.setGuardian(chainId, vm.envAddress("GUARDIAN"));
        for (uint256 i; i < tokens.length; ++i) {
            if (!tw.watched(chainId, tokens[i])) {
                tw.addToken(chainId, tokens[i], thresholds[i]);
            } else if (tw.threshold(chainId, tokens[i]) != thresholds[i]) {
                tw.setThreshold(chainId, tokens[i], thresholds[i]);
            }
        }
        for (uint256 i; i < trusted.length; ++i) {
            tw.setTrusted(trusted[i], true);
        }
        vm.stopBroadcast();
        console.log("chain %d configured with %d tokens", chainId, tw.tokens(chainId).length);
    }
}
