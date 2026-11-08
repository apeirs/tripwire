// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Script, console} from "forge-std/Script.sol";
import {TripwireReactive} from "../src/TripwireReactive.sol";
import {PanicButton} from "../src/PanicButton.sol";
import {Chains} from "./Chains.sol";

interface IMeasureToken {
    function balanceOf(address who) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function mint(address to, uint256 amount) external;
}

/// @notice One transaction step for tools/measure.mjs (latency runs). Keys come from the environment, as in the other
///         scripts; tools/measure.mjs reads the sent transaction's hash from this script's broadcast record.
/// MODE=cooldown  owner sets the merge window on Reactive Network.     Env: PRIVATE_KEY, TRIPWIRE, COOLDOWN (s)
/// MODE=move      HOT sends AMOUNT of TOKEN to TO (the trip).          Env: HOT_PK, TOKEN, TO, AMOUNT (raw units)
/// MODE=approve   HOT approves TO for AMOUNT of TOKEN (the trip).       Env: HOT_PK, TOKEN, TO, AMOUNT (raw units)
/// MODE=panic     the cosigner presses panic (the trip).                Env: COSIGNER_PK, PANIC
/// MODE=mint      tops HOT up on open-mint test tokens.                 Env: PRIVATE_KEY, HOT, TOKENS, AMOUNTS (raw)
/// MODE=refill    COLD sends its whole balance of TOKENS back to HOT    Env: COLD_PK, HOT, TOKENS
///                (tokens nobody can mint, e.g. faucet USDC; COLD -> HOT doesn't trip).
contract Measure is Script {
    function run() external {
        bytes32 m = keccak256(bytes(vm.envString("MODE")));
        if (m == keccak256("cooldown")) {
            require(Chains.isReactive(block.chainid), "run this on Reactive Network");
            TripwireReactive tw = TripwireReactive(payable(vm.envAddress("TRIPWIRE")));
            // forge-lint: disable-next-line(unsafe-typecast) -- setTripCooldown caps it at 1 day.
            uint64 cooldown = uint64(vm.envUint("COOLDOWN"));
            vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
            tw.setTripCooldown(cooldown);
            vm.stopBroadcast();
            console.log("tripCooldown=%d", tw.tripCooldown());
        } else if (m == keccak256("move") || m == keccak256("approve")) {
            IMeasureToken t = IMeasureToken(vm.envAddress("TOKEN"));
            address to = vm.envAddress("TO");
            uint256 amount = vm.envUint("AMOUNT");
            vm.startBroadcast(vm.envUint("HOT_PK"));
            if (m == keccak256("move")) require(t.transfer(to, amount), "transfer failed");
            else require(t.approve(to, amount), "approve failed");
            vm.stopBroadcast();
        } else if (m == keccak256("panic")) {
            PanicButton p = PanicButton(vm.envAddress("PANIC"));
            vm.startBroadcast(vm.envUint("COSIGNER_PK"));
            p.panic();
            vm.stopBroadcast();
        } else if (m == keccak256("mint")) {
            address hot = vm.envAddress("HOT");
            address[] memory tokens = vm.envAddress("TOKENS", ",");
            uint256[] memory amounts = vm.envUint("AMOUNTS", ",");
            require(tokens.length == amounts.length, "AMOUNTS length");
            vm.startBroadcast(vm.envUint("PRIVATE_KEY"));
            for (uint256 i; i < tokens.length; ++i) {
                if (amounts[i] > 0) IMeasureToken(tokens[i]).mint(hot, amounts[i]);
            }
            vm.stopBroadcast();
        } else if (m == keccak256("refill")) {
            address hot = vm.envAddress("HOT");
            address[] memory tokens = vm.envAddress("TOKENS", ",");
            uint256 coldPk = vm.envUint("COLD_PK");
            address cold = vm.addr(coldPk);
            vm.startBroadcast(coldPk);
            for (uint256 i; i < tokens.length; ++i) {
                uint256 bal = IMeasureToken(tokens[i]).balanceOf(cold);
                if (bal > 0) require(IMeasureToken(tokens[i]).transfer(hot, bal), "refill failed");
            }
            vm.stopBroadcast();
        } else {
            revert("MODE must be cooldown, move, approve, panic, mint or refill");
        }
    }
}
