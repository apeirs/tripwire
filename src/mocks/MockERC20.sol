// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

/// @title MockERC20
/// @author apeir
/// @notice Plain test token for the testnet demo: open mint, max allowance is never spent down.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to_, uint256 amount_) external {
        totalSupply += amount_;
        balanceOf[to_] += amount_;
        emit Transfer(address(0), to_, amount_);
    }

    function approve(address spender_, uint256 amount_) external returns (bool) {
        allowance[msg.sender][spender_] = amount_;
        emit Approval(msg.sender, spender_, amount_);
        return true;
    }

    function transfer(address to_, uint256 amount_) external returns (bool) {
        _move(msg.sender, to_, amount_);
        return true;
    }

    function transferFrom(address from_, address to_, uint256 amount_) external virtual returns (bool) {
        uint256 allowed = allowance[from_][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount_) revert InsufficientAllowance();
            allowance[from_][msg.sender] = allowed - amount_;
        }
        _move(from_, to_, amount_);
        return true;
    }

    function _move(address from_, address to_, uint256 amount_) internal {
        if (balanceOf[from_] < amount_) revert InsufficientBalance();
        unchecked {
            balanceOf[from_] -= amount_;
        }
        balanceOf[to_] += amount_;
        emit Transfer(from_, to_, amount_);
    }
}
