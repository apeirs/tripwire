// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";

/// @notice Stand-in for the Reactive Network system contract (0x8888...8888), etched there in tests.
///         Records subscriptions per subscriber and callback requests, the way the network sees them.
contract MockSystem {
    uint256 internal constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;
    uint64 internal constant MIN_CALLBACK_GAS = 100_000;

    struct Sub {
        address subscriber;
        uint256 chainId;
        address target;
        uint256[4] topics;
        bool active;
    }

    struct Req {
        uint256 chainId;
        address sender;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    Sub[] internal _subs;
    Req[] internal _reqs;
    mapping(address => uint256) public debt;
    mapping(address => uint256) public reserves;
    /// @dev Lean mode only emits, like the live system contract, so gas readings aren't skewed by test storage.
    bool public lean;

    event CallbackRequest(uint256 indexed chainId, address indexed sender, address indexed recipient, bytes payload);

    receive() external payable {}

    function setLean(bool lean_) external {
        lean = lean_;
    }

    function depositTo(address contract_) external payable {
        reserves[contract_] += msg.value;
    }

    function subscribe(uint256 chainId_, address contract_, uint256 t0_, uint256 t1_, uint256 t2_, uint256 t3_)
        external
    {
        require(
            chainId_ != 0 || contract_ != address(0) || t0_ != REACTIVE_IGNORE || t1_ != REACTIVE_IGNORE
                || t2_ != REACTIVE_IGNORE || t3_ != REACTIVE_IGNORE,
            "all wildcards"
        );
        _subs.push(Sub(msg.sender, chainId_, contract_, [t0_, t1_, t2_, t3_], true));
    }

    function unsubscribe(uint256 chainId_, address contract_, uint256 t0_, uint256 t1_, uint256 t2_, uint256 t3_)
        external
    {
        for (uint256 i; i < _subs.length; ++i) {
            Sub storage s = _subs[i];
            if (
                s.active && s.subscriber == msg.sender && s.chainId == chainId_ && s.target == contract_
                    && s.topics[0] == t0_ && s.topics[1] == t1_ && s.topics[2] == t2_ && s.topics[3] == t3_
            ) {
                s.active = false;
            }
        }
    }

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 calldata c_) external {
        if (c_.gasLimit < MIN_CALLBACK_GAS) return; // the network ignores these
        if (lean) {
            emit CallbackRequest(c_.chainId, msg.sender, c_.recipient, c_.payload);
            return;
        }
        _reqs.push(Req(c_.chainId, msg.sender, c_.recipient, c_.gasLimit, c_.payload));
        emit CallbackRequest(c_.chainId, msg.sender, c_.recipient, c_.payload);
    }

    // ------------------------------------------------------------ test views

    function matches(address subscriber_, uint256 chainId_, address emitter_, uint256[4] memory topics_)
        external
        view
        returns (bool)
    {
        for (uint256 i; i < _subs.length; ++i) {
            Sub storage s = _subs[i];
            if (!s.active || s.subscriber != subscriber_) continue;
            if (s.chainId != 0 && s.chainId != chainId_) continue;
            if (s.target != address(0) && s.target != emitter_) continue;
            bool ok = true;
            for (uint256 k; k < 4; ++k) {
                if (s.topics[k] != REACTIVE_IGNORE && s.topics[k] != topics_[k]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }

    function activeSubs(address subscriber_) external view returns (uint256 n_) {
        for (uint256 i; i < _subs.length; ++i) {
            if (_subs[i].active && _subs[i].subscriber == subscriber_) ++n_;
        }
    }

    function requestCount() external view returns (uint256) {
        return _reqs.length;
    }

    function request(uint256 i_) external view returns (Req memory) {
        return _reqs[i_];
    }
}
