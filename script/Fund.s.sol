// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {Chains, IDepositTo} from "./Chains.sol";

/// @notice Tops up reserves with `depositTo()`: the system contract on Reactive Network, the callback proxy elsewhere.
/// Env: PRIVATE_KEY, TARGET (TripwireReactive or Guardian), AMOUNT (wei).
contract Fund is Script {
    function run() external {
        address target = vm.envAddress("TARGET");
        uint256 amount = vm.envUint("AMOUNT");
        IDepositTo payee =
            IDepositTo(Chains.isReactive(block.chainid) ? Chains.SYSTEM : Chains.callbackProxy(block.chainid));
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        payee.depositTo{value: amount}(target);
        vm.stopBroadcast();
        console.log("reserves=%d debt=%d", payee.reserves(target), payee.debt(target));
    }
}
