// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {Guardian} from "../src/Guardian.sol";
import {Chains, IDepositTo} from "./Chains.sol";

/// @notice Destination chains, step 3. Deploys the Guardian for TRIPWIRE and credits callback reserves with
///         `depositTo()` on this chain's callback proxy.
/// Env: PRIVATE_KEY, TRIPWIRE, HOT, COLD, FUND (wei of native gas, default 0.005 ether).
contract DeployGuardian is Script {
    function run() external returns (Guardian g_) {
        address proxy = Chains.callbackProxy(block.chainid);
        uint256 fund = vm.envOr("FUND", uint256(0.005 ether));
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        g_ = new Guardian(
            IPayable(payable(proxy)), vm.envAddress("TRIPWIRE"), vm.envAddress("HOT"), vm.envAddress("COLD")
        );
        if (fund > 0) IDepositTo(proxy).depositTo{value: fund}(address(g_));
        vm.stopBroadcast();
        console.log("chain %d", block.chainid);
        console.log("GUARDIAN=%s", address(g_));
    }
}
