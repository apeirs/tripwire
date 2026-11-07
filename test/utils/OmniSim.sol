// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {Test, Vm} from "forge-std/Test.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {MockSystem} from "../mocks/MockSystem.sol";
import {MockCallbackProxy} from "../mocks/MockCallbackProxy.sol";

/// @notice A small in-process model of the Omni loop: origin logs -> subscription match -> react() on the reactive
///         contract (called by the system contract) -> recorded callback requests -> delivery through each
///         destination's callback proxy. Several "chains" share one EVM; each has its own proxy, guardian and tokens.
abstract contract OmniSim is Test {
    address internal constant SYSTEM_ADDR = 0x8888888888888888888888888888888888888888;

    MockSystem internal sys;
    mapping(uint256 chainId => MockCallbackProxy) internal proxyOf;
    uint256 internal relayed;
    uint256 internal txNonce;

    function _installSystem() internal {
        MockSystem impl = new MockSystem();
        vm.etch(SYSTEM_ADDR, address(impl).code);
        sys = MockSystem(payable(SYSTEM_ADDR));
    }

    /// @dev Turns recorded logs into one origin transaction on `chainId_` and feeds the matching ones to `reactive_`.
    function _deliver(address reactive_, uint256 chainId_, Vm.Log[] memory logs_) internal returns (uint256 n_) {
        uint256 txHash = uint256(keccak256(abi.encode("origin-tx", chainId_, ++txNonce)));
        for (uint256 i; i < logs_.length; ++i) {
            IReactive.LogRecord memory rec = _record(chainId_, logs_[i], txHash, i);
            if (!sys.matches(
                    reactive_, chainId_, rec.contractAddress, [rec.topic0, rec.topic1, rec.topic2, rec.topic3]
                )) {
                continue;
            }
            vm.prank(SYSTEM_ADDR);
            IReactive(payable(reactive_)).react(rec);
            ++n_;
        }
    }

    function _record(uint256 chainId_, Vm.Log memory log_, uint256 txHash_, uint256 logIndex_)
        internal
        view
        returns (IReactive.LogRecord memory rec_)
    {
        uint256[4] memory t;
        for (uint256 k; k < log_.topics.length && k < 4; ++k) {
            t[k] = uint256(log_.topics[k]);
        }
        rec_ = IReactive.LogRecord({
            chainId: chainId_,
            contractAddress: log_.emitter,
            topic0: t[0],
            topic1: t[1],
            topic2: t[2],
            topic3: t[3],
            data: log_.data,
            blockNumber: block.number,
            opCode: log_.topics.length,
            blockHash: uint256(blockhash(block.number - 1)),
            txHash: txHash_,
            logIndex: logIndex_
        });
    }

    /// @dev Delivers every callback requested since the last relay. Returns how many failed.
    function _relay() internal returns (uint256 failed_) {
        uint256 total = sys.requestCount();
        for (; relayed < total; ++relayed) {
            MockSystem.Req memory r = sys.request(relayed);
            (bool ok,) = proxyOf[r.chainId].deliver(r.recipient, r.sender, r.gasLimit, r.payload);
            if (!ok) ++failed_;
        }
    }
}
