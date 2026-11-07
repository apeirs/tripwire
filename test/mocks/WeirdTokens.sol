// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {MockERC20} from "../../src/mocks/MockERC20.sol";

/// @notice Records who pulled tokens to whom, so tests can prove the Guardian only ever pays COLD.
contract SpyERC20 is MockERC20 {
    mapping(address spender => address) public firstRecipient;
    mapping(address spender => bool) public mixedRecipients;
    mapping(address spender => mapping(address to => uint256)) public pulled;

    constructor(string memory n_, string memory s_) MockERC20(n_, s_, 18) {}

    function transferFrom(address from_, address to_, uint256 amount_) external override returns (bool) {
        uint256 allowed = allowance[from_][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount_) revert InsufficientAllowance();
            allowance[from_][msg.sender] = allowed - amount_;
        }
        _move(from_, to_, amount_);
        address first = firstRecipient[msg.sender];
        if (first == address(0)) firstRecipient[msg.sender] = to_;
        else if (first != to_) mixedRecipients[msg.sender] = true;
        pulled[msg.sender][to_] += amount_;
        return true;
    }
}

/// @notice OpenZeppelin v4 style: spending an allowance emits a fresh Approval.
contract SpendApprovalERC20 is MockERC20 {
    constructor() MockERC20("Spend", "SPD", 18) {}

    function transferFrom(address from_, address to_, uint256 amount_) external override returns (bool) {
        uint256 allowed = allowance[from_][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount_) revert InsufficientAllowance();
            allowance[from_][msg.sender] = allowed - amount_;
            emit Approval(from_, msg.sender, allowed - amount_);
        }
        _move(from_, to_, amount_);
        return true;
    }
}

/// @notice USDT style: transferFrom returns nothing.
contract NoReturnERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to_, uint256 a_) external {
        balanceOf[to_] += a_;
    }

    function approve(address s_, uint256 a_) external {
        allowance[msg.sender][s_] = a_;
    }

    function transferFrom(address f_, address t_, uint256 a_) external {
        require(allowance[f_][msg.sender] >= a_ && balanceOf[f_] >= a_);
        allowance[f_][msg.sender] -= a_;
        balanceOf[f_] -= a_;
        balanceOf[t_] += a_;
    }
}

/// @notice Returns false instead of moving anything.
contract FalseReturnERC20 is MockERC20 {
    constructor() MockERC20("False", "FLS", 18) {}

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        return false;
    }
}

/// @notice Always reverts on transferFrom.
contract RevertingERC20 is MockERC20 {
    constructor() MockERC20("Revert", "REV", 18) {}

    function transferFrom(address, address, uint256) external pure override returns (bool) {
        revert("nope");
    }
}

/// @notice Burns all gas it is given on every call.
contract GasBurnerERC20 {
    function balanceOf(address) external pure returns (uint256) {
        while (true) {}
        return 0;
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        while (true) {}
        return true;
    }
}

/// @notice Answers balanceOf with a huge blob of return data.
contract ReturnBombERC20 {
    function balanceOf(address) external pure returns (uint256) {
        assembly {
            return(0, 1000000)
        }
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }
}

/// @notice Tries to re-enter the Guardian during the sweep.
contract ReentrantERC20 is MockERC20 {
    address public target;
    bool public reentered;
    bool public reentrySucceeded;

    constructor() MockERC20("Reenter", "RNT", 18) {}

    function setTarget(address t_) external {
        target = t_;
    }

    function transferFrom(address from_, address to_, uint256 amount_) external override returns (bool) {
        if (!reentered && target != address(0)) {
            reentered = true;
            address[] memory list = new address[](1);
            list[0] = address(this);
            (reentrySucceeded,) =
                target.call(abi.encodeWithSignature("sweep(address,uint256,address[])", target, 999, list));
        }
        _move(from_, to_, amount_);
        return true;
    }
}
