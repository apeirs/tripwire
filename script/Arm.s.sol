// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";

interface IApprove {
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Origin chains, step 5, signed by the HOT wallet: approve this chain's Guardian for every token.
///         Safe to grant: the Guardian can only move tokens to COLD, and only on a Tripwire callback.
/// Env: HOT_PK, GUARDIAN, TOKENS (comma list).
contract Arm is Script {
    function run() external {
        address guardian = vm.envAddress("GUARDIAN");
        address[] memory tokens = vm.envAddress("TOKENS", ",");
        vm.startBroadcast(vm.envUint("HOT_PK"));
        for (uint256 i; i < tokens.length; ++i) {
            IApprove(tokens[i]).approve(guardian, type(uint256).max);
        }
        vm.stopBroadcast();
        console.log("armed %d tokens on chain %d", tokens.length, block.chainid);
    }
}
