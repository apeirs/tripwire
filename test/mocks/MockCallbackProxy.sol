// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @notice Stand-in for a destination chain's callback proxy. Like the real one it overwrites the payload's first
///         argument with the requesting reactive contract, holds back gas for its own accounting, and reports a
///         failing callback with an event instead of reverting.
contract MockCallbackProxy {
    /// @dev `_extraGas` + `_maxChargeGas` on Ethereum Sepolia's proxy (150k + 50k, read 2026-11-08); the largest
    ///      of the three test chains.
    uint256 public constant OVERHEAD = 200_000;

    mapping(address => uint256) public debt;
    mapping(address => uint256) public reserves;

    event CallbackDelivered(address indexed recipient, uint256 gasUsed);
    event CallbackFailure(address indexed recipient);

    error NotAContract();
    error InsufficientGas();

    receive() external payable {}

    function depositTo(address contract_) external payable {
        reserves[contract_] += msg.value;
    }

    function deliver(address recipient_, address sender_, uint64 gasLimit_, bytes memory payload_)
        external
        returns (bool ok_, uint256 gasUsed_)
    {
        if (recipient_.code.length == 0) revert NotAContract();
        if (gasLimit_ <= OVERHEAD) revert InsufficientGas();
        assembly ("memory-safe") {
            // [len][selector:4][arg0:32] -> arg0 starts 36 bytes in.
            mstore(add(payload_, 36), sender_)
        }
        uint256 g0 = gasleft();
        (ok_,) = recipient_.call{gas: gasLimit_ - OVERHEAD}(payload_);
        gasUsed_ = g0 - gasleft();
        if (ok_) emit CallbackDelivered(recipient_, gasUsed_);
        else emit CallbackFailure(recipient_);
    }

    /// @notice Charges `amount_` the way the real proxy settles a shortfall: by calling `pay()` on the recipient.
    function charge(address recipient_, uint256 amount_) external {
        (bool ok,) = recipient_.call(abi.encodeWithSignature("pay(uint256)", amount_));
        require(ok, "pay failed");
    }
}
