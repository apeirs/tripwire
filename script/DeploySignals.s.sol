// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {Intent} from "../src/Intent.sol";
import {PanicButton} from "../src/PanicButton.sol";

/// @notice Origin chains, step 1. Deploys Intent and PanicButton through the CREATE2 factory, so both have the same
///         address on every chain.
/// Env: PRIVATE_KEY (deployer), SALT (optional bytes32).
/// Run: forge script script/DeploySignals.s.sol --rpc-url $RPC --broadcast
contract DeploySignals is Script {
    function run() external returns (Intent intent_, PanicButton panic_) {
        bytes32 salt = vm.envOr("SALT", keccak256("apeir.tripwire.v1"));
        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        intent_ = new Intent{salt: salt}();
        panic_ = new PanicButton{salt: salt}();
        vm.stopBroadcast();
        console.log("chain %d", block.chainid);
        console.log("INTENT=%s", address(intent_));
        console.log("PANIC=%s", address(panic_));
    }
}
