// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title PanicButton
/// @author apeir
/// @notice Press it from the hot wallet or the cosigner on any watched chain and Tripwire sweeps every chain.
///         Anyone can press it, but Tripwire only subscribes to presses by those two addresses, so a stranger's
///         press never even reaches it (and costs it nothing).
contract PanicButton {
    event Panic(address indexed caller);

    function panic() external {
        emit Panic(msg.sender);
    }
}
