// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {IPayable} from "@reactive/src/interfaces/IPayable.sol";
import {AbstractCallback} from "@reactive/src/base/AbstractCallback.sol";

/// @title Guardian
/// @author apeir
/// @notice One per protected chain. When the Tripwire reactive contract trips, the Reactive Network callback proxy
///         calls `sweep()`, and the Guardian pulls every token the hot wallet has approved to it over to the cold
///         wallet.
/// @dev Safety properties, all enforced here and covered by tests:
///      - The only recipient of any token movement is the immutable `COLD`. There is no other transfer path.
///      - `sweep()` runs only when called by the callback proxy AND the injected sender is the Tripwire contract.
///      - A trip id is handled at most once; a replay is a no-op. A second sweep of the same state moves nothing.
///      - A broken, reverting, gas-burning or lying token is skipped; it can't block the other tokens.
///      - The Guardian never holds tokens. Its native balance only ever pays the proxy for callbacks.
contract Guardian is AbstractCallback {
    /// @notice Why a token was skipped.
    enum SkipReason {
        NotAContract,
        ReadFailed,
        NothingToMove,
        TransferFailed,
        OutOfGas
    }

    /// @notice Gas forwarded to each token call, so one hostile token can't starve the rest.
    uint256 public constant TOKEN_CALL_GAS = 100_000;

    /// @notice A token is only attempted with at least this much gas left: its three capped calls plus bookkeeping.
    ///         So a sweep can run short and skip the tail, but it can never run out of gas and undo what it moved.
    uint256 public constant MIN_GAS_PER_TOKEN = 3 * TOKEN_CALL_GAS + 30_000;

    /// @notice Hard cap on tokens handled per sweep.
    uint256 public constant MAX_TOKENS = 32;

    /// @notice The protected wallet. Tokens are pulled from here, up to its allowance to this contract.
    address public immutable HOT;

    /// @notice The only address that can ever receive anything from this contract.
    address public immutable COLD;

    /// @notice Trip ids already handled.
    mapping(uint256 tripId => bool) public handled;

    event Swept(uint256 indexed tripId, address indexed token, uint256 amount);
    event Skipped(uint256 indexed tripId, address indexed token, SkipReason reason);
    event SweepDone(uint256 indexed tripId, uint256 swept, uint256 skipped);
    event Replayed(uint256 indexed tripId);

    error ZeroAddress();
    error HotIsCold();

    /// @param callbackProxy_ Reactive Network callback proxy on this chain.
    /// @param tripwire_ The TripwireReactive contract on Reactive Network (the only allowed callback sender).
    /// @param hot_ The wallet to protect.
    /// @param cold_ Where everything goes.
    constructor(IPayable callbackProxy_, address tripwire_, address hot_, address cold_)
        payable
        AbstractCallback(callbackProxy_, tripwire_)
    {
        if (
            address(callbackProxy_) == address(0) || tripwire_ == address(0) || hot_ == address(0)
                || cold_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (hot_ == cold_) revert HotIsCold();
        HOT = hot_;
        COLD = cold_;
    }

    /// @notice Pulls `min(balanceOf(HOT), allowance(HOT, this))` of each token from HOT to COLD.
    /// @param sender_ Overwritten by the network with the address of the reactive contract that asked for the callback.
    /// @param tripId_ Trip counter from the reactive contract; each id is handled once.
    /// @param tokens_ Tokens to sweep on this chain (at most `MAX_TOKENS` are handled).
    function sweep(address sender_, uint256 tripId_, address[] calldata tokens_)
        external
        onlyServiceProvider
        onlyCallbackSender(sender_)
    {
        if (handled[tripId_]) {
            emit Replayed(tripId_);
            return;
        }
        handled[tripId_] = true;

        uint256 n = tokens_.length < MAX_TOKENS ? tokens_.length : MAX_TOKENS;
        uint256 swept;
        for (uint256 i; i < n; ++i) {
            address token = tokens_[i];
            if (gasleft() < MIN_GAS_PER_TOKEN) {
                emit Skipped(tripId_, token, SkipReason.OutOfGas);
                break;
            }
            (bool moved, uint256 amount, SkipReason reason) = _sweepOne(token);
            if (moved) {
                ++swept;
                emit Swept(tripId_, token, amount);
            } else {
                emit Skipped(tripId_, token, reason);
            }
        }
        emit SweepDone(tripId_, swept, tokens_.length - swept);
    }

    /// @notice Settles any callback debt from this contract's own balance. Anyone may call it.
    function coverDebt() external {
        _coverDebt();
    }

    /// @notice What a sweep would move right now for `token_`.
    function sweepable(address token_) external view returns (uint256) {
        if (token_.code.length == 0) return 0;
        (bool okB, uint256 bal) = _read(token_, abi.encodeWithSelector(0x70a08231, HOT));
        (bool okA, uint256 allow) = _read(token_, abi.encodeWithSelector(0xdd62ed3e, HOT, address(this)));
        if (!okB || !okA) return 0;
        return bal < allow ? bal : allow;
    }

    function _sweepOne(address token_) private returns (bool moved_, uint256 amount_, SkipReason reason_) {
        if (token_.code.length == 0) return (false, 0, SkipReason.NotAContract);

        // balanceOf(HOT)
        (bool okB, uint256 bal) = _read(token_, abi.encodeWithSelector(0x70a08231, HOT));
        // allowance(HOT, this)
        (bool okA, uint256 allow) = _read(token_, abi.encodeWithSelector(0xdd62ed3e, HOT, address(this)));
        if (!okB || !okA) return (false, 0, SkipReason.ReadFailed);

        amount_ = bal < allow ? bal : allow;
        if (amount_ == 0) return (false, 0, SkipReason.NothingToMove);

        // transferFrom(HOT, COLD, amount): the recipient is fixed to COLD here and nowhere else.
        if (!_transferFrom(token_, amount_)) return (false, 0, SkipReason.TransferFailed);
        return (true, amount_, reason_);
    }

    /// @dev Gas-capped staticcall that copies at most one word back (no return-data bombs).
    function _read(address token_, bytes memory data_) private view returns (bool ok_, uint256 value_) {
        assembly ("memory-safe") {
            mstore(0x00, 0)
            ok_ := staticcall(TOKEN_CALL_GAS, token_, add(data_, 0x20), mload(data_), 0x00, 0x20)
            ok_ := and(ok_, gt(returndatasize(), 0x1f))
            value_ := mload(0x00)
        }
    }

    /// @dev Gas-capped call to `transferFrom(HOT, COLD, amount)`. Accepts tokens that return nothing (USDT style)
    ///      and tokens that return `true`; anything else counts as a failure.
    function _transferFrom(address token_, uint256 amount_) private returns (bool ok_) {
        bytes memory data = abi.encodeWithSelector(0x23b872dd, HOT, COLD, amount_);
        assembly ("memory-safe") {
            mstore(0x00, 0)
            ok_ := call(TOKEN_CALL_GAS, token_, 0, add(data, 0x20), mload(data), 0x00, 0x20)
            ok_ := and(ok_, or(iszero(returndatasize()), and(gt(returndatasize(), 0x1f), eq(mload(0x00), 1))))
        }
    }
}
