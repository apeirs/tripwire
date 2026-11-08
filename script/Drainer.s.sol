// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {Drainer} from "../src/mocks/Drainer.sol";

interface IToken {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @notice Simulated attacks for the demo, on demo tokens only (tUSD/tETH/tDAI on testnets, the worthless TDTA/B/C
///         on mainnets; see DeployMocks).
/// MODE=deploy  attacker deploys a Drainer.                       Env: ATTACKER_PK
/// MODE=phish   the victim signs approvals to the Drainer.        Env: HOT_PK, DRAINER, TOKENS
/// MODE=pull    the drainer pulls one token per transaction.      Env: ATTACKER_PK, DRAINER, HOT, TOKENS
/// MODE=sweep   a stolen hot key empties each token, one tx each. Env: HOT_PK, ATTACKER, TOKENS
contract DrainerScript is Script {
    function run() external {
        string memory mode = vm.envString("MODE");
        bytes32 m = keccak256(bytes(mode));
        if (m == keccak256("deploy")) {
            vm.startBroadcast(vm.envUint("ATTACKER_PK"));
            Drainer d = new Drainer();
            vm.stopBroadcast();
            console.log("DRAINER=%s", address(d));
            return;
        }

        address[] memory tokens = vm.envAddress("TOKENS", ",");
        if (m == keccak256("phish")) {
            address drainer = vm.envAddress("DRAINER");
            vm.startBroadcast(vm.envUint("HOT_PK"));
            for (uint256 i; i < tokens.length; ++i) {
                IToken(tokens[i]).approve(drainer, type(uint256).max);
            }
            vm.stopBroadcast();
        } else if (m == keccak256("pull")) {
            Drainer drainer = Drainer(vm.envAddress("DRAINER"));
            address hot = vm.envAddress("HOT");
            vm.startBroadcast(vm.envUint("ATTACKER_PK"));
            for (uint256 i; i < tokens.length; ++i) {
                drainer.drain(tokens[i], hot);
            }
            vm.stopBroadcast();
        } else if (m == keccak256("sweep")) {
            address attacker = vm.envAddress("ATTACKER");
            uint256 hotPk = vm.envUint("HOT_PK");
            address hot = vm.addr(hotPk);
            vm.startBroadcast(hotPk);
            for (uint256 i; i < tokens.length; ++i) {
                uint256 bal = IToken(tokens[i]).balanceOf(hot);
                if (bal > 0) require(IToken(tokens[i]).transfer(attacker, bal), "transfer failed");
            }
            vm.stopBroadcast();
        } else {
            revert("MODE must be deploy, phish, pull or sweep");
        }
        console.log("%s done on chain %d", mode, block.chainid);
    }
}
