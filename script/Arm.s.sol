// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {Tokens} from "./Tokens.sol";

interface IArmToken {
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice Origin chains, step 5, signed by the HOT wallet: approve this chain's Guardian for every token.
///         Safe to grant: the Guardian can only move tokens to COLD, and only on a Tripwire callback.
/// Env: HOT_PK, GUARDIAN, the token list (see Tokens.sol: TOKENS, USDC=true for Circle's testnet USDC).
contract Arm is Script {
    error NotAToken(address token);

    function run() external {
        address guardian = vm.envAddress("GUARDIAN");
        (address[] memory tokens,) = Tokens.list(block.chainid);
        for (uint256 i; i < tokens.length; ++i) {
            // A wrong address (another chain's USDC, a typo) would approve nothing and be skipped in every sweep.
            if (tokens[i].code.length == 0) revert NotAToken(tokens[i]);
            IArmToken t = IArmToken(tokens[i]);
            console.log("%s (%d decimals) %s", t.symbol(), t.decimals(), tokens[i]);
        }
        vm.startBroadcast(vm.envUint("HOT_PK"));
        for (uint256 i; i < tokens.length; ++i) {
            IArmToken(tokens[i]).approve(guardian, type(uint256).max);
        }
        vm.stopBroadcast();
        console.log("armed %d tokens on chain %d", tokens.length, block.chainid);
    }
}
