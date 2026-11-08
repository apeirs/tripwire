// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {Chains} from "./Chains.sol";

/// @notice Origin chains, demo only. Three test tokens at the same address on every chain, minted to HOT.
///         On a mainnet they are "Tripwire Demo Token A/B/C (worthless)", TDTA/TDTB/TDTC: open-mint tokens on a
///         public chain must not look like a real asset (no USD/ETH/DAI in the name or symbol).
/// Env: PRIVATE_KEY, HOT, MINT (optional, whole tokens, default 1000), SALT (optional).
contract DeployMocks is Script {
    function run() external returns (MockERC20[3] memory t_) {
        address hot = vm.envAddress("HOT");
        uint256 mint = vm.envOr("MINT", uint256(1000));
        bytes32 salt = vm.envOr("SALT", keccak256("apeir.tripwire.v1"));
        bool live = Chains.isMainnet(block.chainid);
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        t_[0] = live
            ? new MockERC20{salt: salt}("Tripwire Demo Token A (worthless)", "TDTA", 6)
            : new MockERC20{salt: salt}("Tripwire Test USD", "tUSD", 6);
        t_[1] = live
            ? new MockERC20{salt: salt}("Tripwire Demo Token B (worthless)", "TDTB", 18)
            : new MockERC20{salt: salt}("Tripwire Test ETH", "tETH", 18);
        t_[2] = live
            ? new MockERC20{salt: salt}("Tripwire Demo Token C (worthless)", "TDTC", 18)
            : new MockERC20{salt: salt}("Tripwire Test DAI", "tDAI", 18);
        for (uint256 i; i < 3; ++i) {
            t_[i].mint(hot, mint * 10 ** t_[i].decimals());
        }
        vm.stopBroadcast();
        console.log("TOKENS=%s,%s,%s", address(t_[0]), address(t_[1]), address(t_[2]));
    }
}
