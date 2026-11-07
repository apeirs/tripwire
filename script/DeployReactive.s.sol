// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {TripwireReactive} from "../src/TripwireReactive.sol";
import {Chains} from "./Chains.sol";

/// @notice Reactive Network (Lasna), step 2. Deploys TripwireReactive, funded through its payable constructor.
/// Env: PRIVATE_KEY (becomes owner), HOT, COLD, COSIGNER, CHAIN_IDS (comma list), INTENTS, PANICS (comma lists,
///      same order; 0x0000000000000000000000000000000000000000 for none), FUND (wei of lREACT, default 2 ether).
/// Run: forge script script/DeployReactive.s.sol --rpc-url https://lasna-rpc.rnk.dev/ --broadcast
contract DeployReactive is Script {
    function run() external returns (TripwireReactive tw_) {
        require(Chains.isReactive(block.chainid), "run this on Reactive Network");
        uint256[] memory ids = vm.envUint("CHAIN_IDS", ",");
        address[] memory intents = vm.envAddress("INTENTS", ",");
        address[] memory panics = vm.envAddress("PANICS", ",");
        uint256 fund = vm.envOr("FUND", uint256(2 ether));

        vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
        tw_ = new TripwireReactive{value: fund}(
            vm.envAddress("HOT"), vm.envAddress("COLD"), vm.envAddress("COSIGNER"), ids, intents, panics
        );
        vm.stopBroadcast();
        console.log("TRIPWIRE=%s", address(tw_));
    }
}
