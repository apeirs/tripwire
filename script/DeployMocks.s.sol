// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";

/// @notice Origin chains, demo only. Three test tokens at the same address on every chain, minted to HOT.
/// Env: PRIVATE_KEY, HOT, MINT (optional, whole tokens, default 1000), SALT (optional).
contract DeployMocks is Script {
    function run() external returns (MockERC20[3] memory t_) {
        address hot = vm.envAddress("HOT");
        uint256 mint = vm.envOr("MINT", uint256(1000));
        bytes32 salt = vm.envOr("SALT", keccak256("apeir.tripwire.v1"));
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        t_[0] = new MockERC20{salt: salt}("Tripwire Test USD", "tUSD", 6);
        t_[1] = new MockERC20{salt: salt}("Tripwire Test ETH", "tETH", 18);
        t_[2] = new MockERC20{salt: salt}("Tripwire Test DAI", "tDAI", 18);
        for (uint256 i; i < 3; ++i) {
            t_[i].mint(hot, mint * 10 ** t_[i].decimals());
        }
        vm.stopBroadcast();
        console.log("TOKENS=%s,%s,%s", address(t_[0]), address(t_[1]), address(t_[2]));
    }
}
