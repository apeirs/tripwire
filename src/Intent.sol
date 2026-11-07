// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title Intent
/// @author apeir
/// @notice Pre-clears one outgoing transfer (or approval) on this chain so Tripwire doesn't trip on it.
///         Call `intend()`, wait for it to confirm, then send. Tripwire only honours intents from its configured
///         cosigner, so a thief holding the hot key alone can't pre-clear a drain (unless cosigner == hot).
/// @dev Stateless: the event is the message. Deploy with CREATE2 for the same address on every chain.
contract Intent {
    /// @notice Longest an intent may live.
    uint64 public constant MAX_TTL = 1 days;

    /// @param owner Who signed the intent (Tripwire checks it against its cosigner).
    /// @param token ERC-20 the transfer or approval is for.
    /// @param to Recipient of the transfer, or spender of the approval.
    /// @param amount Most it may move in total; consumed as transfers arrive. 0 cancels an earlier intent.
    /// @param expiry Unix time after which it no longer clears anything.
    event Intend(address indexed owner, address indexed token, address indexed to, uint256 amount, uint64 expiry);

    error BadExpiry(uint64 expiry);

    /// @notice Pre-clears up to `amount_` of `token_` to `to_` until `expiry_`.
    function intend(address token_, address to_, uint256 amount_, uint64 expiry_) external {
        if (expiry_ <= block.timestamp || expiry_ > block.timestamp + MAX_TTL) revert BadExpiry(expiry_);
        emit Intend(msg.sender, token_, to_, amount_, expiry_);
    }

    /// @notice Same as `intend()` with a relative lifetime in seconds.
    function intendFor(address token_, address to_, uint256 amount_, uint64 ttl_) external {
        if (ttl_ == 0 || ttl_ > MAX_TTL) revert BadExpiry(ttl_);
        emit Intend(msg.sender, token_, to_, amount_, uint64(block.timestamp) + ttl_);
    }
}
