// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Vm} from "forge-std/Vm.sol";
import {Chains} from "./Chains.sol";

/// @notice The guarded token list for one chain, shared by Configure (on Reactive Network) and Arm (on the chain).
/// Env: TOKENS (comma list, optional when USDC=true), THRESHOLDS (optional, same length as TOKENS, raw units),
///      USDC (optional bool: also guard Circle's USDC on that chain, testnet or mainnet), USDC_THRESHOLD (optional,
///      raw units: USDC has 6 decimals, so 5 USDC = 5000000; default 0).
/// Thresholds are always raw token units, so a 6-decimal and an 18-decimal token need different numbers.
library Tokens {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error NoTokens();
    error ThresholdsLength();
    error NoUsdcOnChain(uint256 chainId);

    function list(uint256 chainId_) internal view returns (address[] memory tokens_, uint256[] memory thresholds_) {
        address[] memory base = VM.envOr("TOKENS", ",", new address[](0));
        uint256[] memory th = VM.envOr("THRESHOLDS", ",", new uint256[](0));
        if (th.length != 0 && th.length != base.length) revert ThresholdsLength();

        address usdc;
        if (VM.envOr("USDC", false)) {
            usdc = Chains.usdc(chainId_);
            if (usdc == address(0)) revert NoUsdcOnChain(chainId_);
            for (uint256 i; i < base.length; ++i) {
                if (base[i] == usdc) usdc = address(0); // already listed in TOKENS
            }
        }

        uint256 n = base.length + (usdc == address(0) ? 0 : 1);
        if (n == 0) revert NoTokens();
        tokens_ = new address[](n);
        thresholds_ = new uint256[](n);
        for (uint256 i; i < base.length; ++i) {
            tokens_[i] = base[i];
            thresholds_[i] = th.length == 0 ? 0 : th[i];
        }
        if (usdc != address(0)) {
            tokens_[n - 1] = usdc;
            thresholds_[n - 1] = VM.envOr("USDC_THRESHOLD", uint256(0));
        }
    }
}
