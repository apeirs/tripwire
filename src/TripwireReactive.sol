// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {ISystemContract} from "@reactive/src/interfaces/ISystemContract.sol";
import {IReactive} from "@reactive/src/interfaces/IReactive.sol";
import {AbstractReactive} from "@reactive/src/base/AbstractReactive.sol";
import {Guardian} from "./Guardian.sol";

/// @title TripwireReactive
/// @author apeir
/// @notice Runs on Reactive Network. Watches one hot wallet's registered ERC-20s on several chains. The first
///         outgoing transfer or approval it can't explain trips it, and it asks every chain's Guardian to sweep all
///         approved tokens to the cold wallet.
/// @dev What explains (clears) an outgoing move, in order:
///      1. the recipient / spender is COLD or on the trusted list;
///      2. the amount is at or below the per-token threshold;
///      3. a live intent from the cosigner covers it (consumed as used).
///      Anything else trips. So does the Guardian's own allowance dropping below `GUARDIAN_ALLOWANCE_FLOOR` (a thief
///      revoking the guard first), and a `Panic` from the hot wallet or the cosigner.
///      Every log is processed at most once (key = chain id, tx hash, log index).
///      Trips merge: a second trip from the same origin transaction, or any trip less than `tripCooldown` seconds
///      (Reactive Network block time) after the last one that fired, requests no new sweep. It is still recorded
///      (`TripMerged`, and `Observed` with verdict `Merged`). The window starts at the trip that fired and is never
///      extended by merged ones, so a trip after it always fires again. A `Panic` from the cosigner always fires.
contract TripwireReactive is AbstractReactive {
    enum Reason {
        Transfer,
        Approval,
        GuardianRevoked,
        Panic
    }

    enum Verdict {
        Trusted,
        UnderThreshold,
        Intended,
        Tripped,
        /// @dev Would have tripped, but folded into the latest trip (same origin tx, or inside `tripCooldown`).
        Merged,
        Ignored
    }

    struct ChainConfig {
        address guardian;
        address intent;
        address panicButton;
        address[] tokens;
    }

    struct IntentSlot {
        uint128 amount;
        uint64 expiry;
    }

    uint256 public constant TRANSFER_TOPIC_0 = uint256(keccak256("Transfer(address,address,uint256)"));
    uint256 public constant APPROVAL_TOPIC_0 = uint256(keccak256("Approval(address,address,uint256)"));
    uint256 public constant INTEND_TOPIC_0 = uint256(keccak256("Intend(address,address,address,uint256,uint64)"));
    uint256 public constant PANIC_TOPIC_0 = uint256(keccak256("Panic(address)"));

    uint256 public constant MAX_CHAINS = 8;
    uint256 public constant MAX_TOKENS_PER_CHAIN = 16;
    uint64 public constant MAX_INTENT_TTL = 1 days;

    /// @notice Merge window after a trip, in seconds of Reactive Network block time. Long enough for the requested
    ///         sweeps to land on every chain (Ethereum Sepolia's 12-second blocks included), short enough that a
    ///         new move soon after re-trips. Owner-settable up to `MAX_TRIP_COOLDOWN`; 0 merges same-tx trips only.
    uint64 public constant DEFAULT_TRIP_COOLDOWN = 5 minutes;
    uint64 public constant MAX_TRIP_COOLDOWN = 1 days;

    /// @notice An approval to the Guardian below this counts as the guard being revoked. Approve it with max uint.
    uint256 public constant GUARDIAN_ALLOWANCE_FLOOR = 1 << 128;

    /// @notice Callback gas: proxy overhead (up to 200k on Ethereum Sepolia) + sweep base + the Guardian's
    ///         per-token gas reserve, then a per-token allowance. Unused gas isn't billed.
    uint64 public constant CALLBACK_BASE_GAS = 650_000;
    uint64 public constant CALLBACK_GAS_PER_TOKEN = 60_000;

    address public immutable HOT;
    address public immutable COLD;
    /// @notice Second key allowed to pre-clear transfers and press panic. Use one the hot wallet's thief won't have.
    address public immutable COSIGNER;

    address public owner;
    /// @notice Number of trips so far; also the id of the latest trip.
    uint256 public trips;
    /// @notice keccak(chain id, tx hash) of the origin transaction behind the latest trip.
    bytes32 public lastTripTx;
    /// @notice Reactive Network `block.timestamp` of the latest trip that requested sweeps.
    uint64 public lastTripAt;
    /// @notice Trips within this many seconds of `lastTripAt` merge into it (see the contract notes).
    uint64 public tripCooldown;

    uint256[] internal _chainIds;
    mapping(uint256 chainId => ChainConfig) internal _chains;
    mapping(uint256 chainId => bool) public isChain;
    mapping(uint256 chainId => mapping(address token => bool)) public watched;
    mapping(uint256 chainId => mapping(address token => uint256)) public threshold;
    mapping(address account => bool) public trusted;
    mapping(bytes32 key => IntentSlot) public intents;
    mapping(bytes32 logKey => bool) public seen;

    /// @param txHash Origin transaction of the log, so a verdict links to its move exactly (with `logIndex`).
    event Observed(
        uint256 indexed chainId,
        uint256 indexed topic0,
        address indexed counterparty,
        uint256 amount,
        Verdict verdict,
        uint256 txHash,
        uint256 logIndex
    );
    event Tripped(
        uint256 indexed tripId, Reason indexed reason, uint256 indexed chainId, uint256 txHash, uint256 logIndex
    );
    /// @notice A move that would have tripped, folded into trip `tripId` without new sweeps.
    event TripMerged(
        uint256 indexed tripId, Reason indexed reason, uint256 indexed chainId, uint256 txHash, uint256 logIndex
    );
    event SweepRequested(uint256 indexed tripId, uint256 indexed chainId, address guardian, uint256 tokens);
    event IntentSet(uint256 indexed chainId, address indexed token, address indexed to, uint256 amount, uint64 expiry);
    event Duplicate(uint256 indexed chainId, uint256 txHash, uint256 logIndex);
    event GuardianSet(uint256 indexed chainId, address guardian);
    event TokenAdded(uint256 indexed chainId, address indexed token, uint256 threshold);
    event TokenRemoved(uint256 indexed chainId, address indexed token);
    event ThresholdSet(uint256 indexed chainId, address indexed token, uint256 threshold);
    event TrustedSet(address indexed account, bool trusted);
    event TripCooldownSet(uint64 cooldown);
    event OwnerSet(address indexed owner);

    error NotOwner();
    error ZeroAddress();
    error HotIsCold();
    error BadConfig();
    error UnknownChain(uint256 chainId);
    error TooMany();
    error AlreadyWatched(address token);
    error NotWatched(address token);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @param hot_ Wallet to protect.
    /// @param cold_ Where sweeps send everything.
    /// @param cosigner_ Key allowed to issue intents and press panic (may equal `hot_`, which is weaker).
    /// @param chainIds_ Chains to watch and protect.
    /// @param intents_ Intent contract per chain (address(0): no intents on that chain).
    /// @param panicButtons_ PanicButton per chain (address(0): none).
    constructor(
        address hot_,
        address cold_,
        address cosigner_,
        uint256[] memory chainIds_,
        address[] memory intents_,
        address[] memory panicButtons_
    ) payable {
        if (hot_ == address(0) || cold_ == address(0) || cosigner_ == address(0)) {
            revert ZeroAddress();
        }
        if (hot_ == cold_) revert HotIsCold();
        if (chainIds_.length != intents_.length || chainIds_.length != panicButtons_.length) revert BadConfig();
        if (chainIds_.length == 0 || chainIds_.length > MAX_CHAINS) revert TooMany();

        HOT = hot_;
        COLD = cold_;
        COSIGNER = cosigner_;
        owner = msg.sender;
        emit OwnerSet(msg.sender);
        tripCooldown = DEFAULT_TRIP_COOLDOWN;
        emit TripCooldownSet(DEFAULT_TRIP_COOLDOWN);

        for (uint256 i; i < chainIds_.length; ++i) {
            uint256 chainId = chainIds_[i];
            if (chainId == 0 || isChain[chainId]) revert BadConfig();
            isChain[chainId] = true;
            _chainIds.push(chainId);
            ChainConfig storage c = _chains[chainId];
            c.intent = intents_[i];
            c.panicButton = panicButtons_[i];

            if (intents_[i] != address(0)) {
                SYSTEM.subscribe(
                    chainId, intents_[i], INTEND_TOPIC_0, uint256(uint160(cosigner_)), REACTIVE_IGNORE, REACTIVE_IGNORE
                );
            }
            if (panicButtons_[i] != address(0)) {
                SYSTEM.subscribe(
                    chainId, panicButtons_[i], PANIC_TOPIC_0, uint256(uint160(hot_)), REACTIVE_IGNORE, REACTIVE_IGNORE
                );
                if (cosigner_ != hot_) {
                    SYSTEM.subscribe(
                        chainId,
                        panicButtons_[i],
                        PANIC_TOPIC_0,
                        uint256(uint160(cosigner_)),
                        REACTIVE_IGNORE,
                        REACTIVE_IGNORE
                    );
                }
            }
        }
    }

    // ---------------------------------------------------------------- reactive entry point

    /// @inheritdoc IReactive
    function react(LogRecord calldata log_) external onlySystem {
        bytes32 logKey = keccak256(abi.encode(log_.chainId, log_.txHash, log_.logIndex));
        if (seen[logKey]) {
            emit Duplicate(log_.chainId, log_.txHash, log_.logIndex);
            return;
        }
        seen[logKey] = true;

        // Logs that don't fit fall through without reverting: a revert is still billed.
        if (!isChain[log_.chainId]) return;
        uint256 topic0 = log_.topic0;
        if (topic0 == TRANSFER_TOPIC_0 || topic0 == APPROVAL_TOPIC_0) {
            _onMove(log_);
        } else if (topic0 == INTEND_TOPIC_0) {
            _onIntend(log_);
        } else if (topic0 == PANIC_TOPIC_0) {
            _onPanic(log_);
        }
    }

    // ---------------------------------------------------------------- owner configuration (on Reactive Network)

    /// @notice Points a chain at its Guardian. The Guardian can only ever pay COLD, so this can't redirect funds.
    function setGuardian(uint256 chainId_, address guardian_) external onlyOwner {
        if (!isChain[chainId_]) revert UnknownChain(chainId_);
        _chains[chainId_].guardian = guardian_;
        emit GuardianSet(chainId_, guardian_);
    }

    /// @notice Watches `token_` on `chainId_` and includes it in that chain's sweeps.
    function addToken(uint256 chainId_, address token_, uint256 threshold_) external onlyOwner {
        if (!isChain[chainId_]) revert UnknownChain(chainId_);
        if (token_ == address(0)) revert ZeroAddress();
        if (watched[chainId_][token_]) revert AlreadyWatched(token_);
        ChainConfig storage c = _chains[chainId_];
        if (c.tokens.length >= MAX_TOKENS_PER_CHAIN) revert TooMany();
        c.tokens.push(token_);
        watched[chainId_][token_] = true;
        threshold[chainId_][token_] = threshold_;
        _setMoveSubscriptions(chainId_, token_, true);
        emit TokenAdded(chainId_, token_, threshold_);
    }

    function removeToken(uint256 chainId_, address token_) external onlyOwner {
        if (!watched[chainId_][token_]) revert NotWatched(token_);
        address[] storage list = _chains[chainId_].tokens;
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == token_) {
                list[i] = list[n - 1];
                list.pop();
                break;
            }
        }
        delete watched[chainId_][token_];
        delete threshold[chainId_][token_];
        _setMoveSubscriptions(chainId_, token_, false);
        emit TokenRemoved(chainId_, token_);
    }

    function setThreshold(uint256 chainId_, address token_, uint256 threshold_) external onlyOwner {
        if (!watched[chainId_][token_]) revert NotWatched(token_);
        threshold[chainId_][token_] = threshold_;
        emit ThresholdSet(chainId_, token_, threshold_);
    }

    /// @notice Recipients and spenders that never trip (an exchange deposit address, a router you use).
    function setTrusted(address account_, bool trusted_) external onlyOwner {
        trusted[account_] = trusted_;
        emit TrustedSet(account_, trusted_);
    }

    /// @notice Sets the merge window. Longer spends less on repeated trips; shorter re-arms sooner after a sweep.
    function setTripCooldown(uint64 cooldown_) external onlyOwner {
        if (cooldown_ > MAX_TRIP_COOLDOWN) revert TooMany();
        tripCooldown = cooldown_;
        emit TripCooldownSet(cooldown_);
    }

    function setOwner(address owner_) external onlyOwner {
        owner = owner_;
        emit OwnerSet(owner_);
    }

    /// @notice Settles any debt to the system contract from this contract's balance. Anyone may call it.
    function coverDebt() external {
        _coverDebt();
    }

    // ---------------------------------------------------------------- views

    function chainIds() external view returns (uint256[] memory) {
        return _chainIds;
    }

    function chainConfig(uint256 chainId_) external view returns (ChainConfig memory) {
        return _chains[chainId_];
    }

    function tokens(uint256 chainId_) external view returns (address[] memory) {
        return _chains[chainId_].tokens;
    }

    /// @notice Gas limit requested for a sweep callback over `tokenCount_` tokens.
    function callbackGasLimit(uint256 tokenCount_) public pure returns (uint64) {
        // forge-lint: disable-next-line(unsafe-typecast) -- token counts are capped at MAX_TOKENS_PER_CHAIN.
        return CALLBACK_BASE_GAS + CALLBACK_GAS_PER_TOKEN * uint64(tokenCount_);
    }

    function intentKey(uint256 chainId_, address token_, address to_) public pure returns (bytes32) {
        return keccak256(abi.encode(chainId_, token_, to_));
    }

    // ---------------------------------------------------------------- handlers

    function _onMove(LogRecord calldata log_) private {
        address token = log_.contractAddress;
        if (
            log_.opCode != 3 || log_.data.length < 32 || !watched[log_.chainId][token]
                || address(uint160(log_.topic1)) != HOT
        ) return;

        bool isTransfer = log_.topic0 == TRANSFER_TOPIC_0;
        address counterparty = address(uint160(log_.topic2));
        uint256 amount = abi.decode(log_.data[:32], (uint256));
        Verdict verdict;

        if (!isTransfer && counterparty == _chains[log_.chainId].guardian) {
            // Approval to our own Guardian: fine while it stays (near) infinite, a trip if someone cuts it.
            verdict = amount >= GUARDIAN_ALLOWANCE_FLOOR ? Verdict.Trusted : _trip(Reason.GuardianRevoked, log_, false);
        } else if (counterparty == COLD || trusted[counterparty] || (!isTransfer && amount == 0)) {
            verdict = Verdict.Trusted;
        } else if (amount <= threshold[log_.chainId][token]) {
            verdict = Verdict.UnderThreshold;
        } else if (_consumeIntent(log_.chainId, token, counterparty, amount)) {
            verdict = Verdict.Intended;
        } else {
            verdict = _trip(isTransfer ? Reason.Transfer : Reason.Approval, log_, false);
        }
        emit Observed(log_.chainId, log_.topic0, counterparty, amount, verdict, log_.txHash, log_.logIndex);
    }

    function _onIntend(LogRecord calldata log_) private {
        if (
            log_.opCode != 4 || log_.contractAddress != _chains[log_.chainId].intent
                || address(uint160(log_.topic1)) != COSIGNER || log_.data.length < 64
        ) return;
        (uint256 amount, uint64 expiry) = abi.decode(log_.data[:64], (uint256, uint64));
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_INTENT_TTL) return;
        address token = address(uint160(log_.topic2));
        address to = address(uint160(log_.topic3));
        // forge-lint: disable-next-line(unsafe-typecast) -- clamped to uint128 on the same line.
        uint128 capped = amount > type(uint128).max ? type(uint128).max : uint128(amount);
        intents[intentKey(log_.chainId, token, to)] = IntentSlot({amount: capped, expiry: expiry});
        emit IntentSet(log_.chainId, token, to, capped, expiry);
    }

    function _onPanic(LogRecord calldata log_) private {
        address caller = address(uint160(log_.topic1));
        if (log_.contractAddress != _chains[log_.chainId].panicButton || (caller != HOT && caller != COSIGNER)) return;
        // The cosigner's panic always fires. The hot key's is merged like any other move from that key: a thief
        // holding it could otherwise press panic in a loop and burn the callback reserves.
        Verdict verdict = _trip(Reason.Panic, log_, caller == COSIGNER);
        emit Observed(log_.chainId, log_.topic0, caller, 0, verdict, log_.txHash, log_.logIndex);
    }

    // ---------------------------------------------------------------- internals

    /// @dev True if a live intent covers the move; the covered amount is used up.
    function _consumeIntent(uint256 chainId_, address token_, address to_, uint256 amount_) private returns (bool) {
        bytes32 key = intentKey(chainId_, token_, to_);
        IntentSlot memory slot = intents[key];
        if (slot.expiry < block.timestamp || amount_ > slot.amount) return false;
        // forge-lint: disable-next-line(unsafe-typecast) -- amount_ <= slot.amount, a uint128, checked above.
        uint128 left = slot.amount - uint128(amount_);
        if (left == 0) delete intents[key];
        else intents[key].amount = left;
        return true;
    }

    /// @dev Requests a sweep on every chain, unless the trip merges into the latest one (see the contract notes).
    ///      `force_` skips merging (the cosigner's panic).
    function _trip(Reason reason_, LogRecord calldata log_, bool force_) private returns (Verdict) {
        bytes32 txKey = keccak256(abi.encode(log_.chainId, log_.txHash));
        if (
            !force_ && trips != 0
                && (txKey == lastTripTx || block.timestamp < uint256(lastTripAt) + uint256(tripCooldown))
        ) {
            emit TripMerged(trips, reason_, log_.chainId, log_.txHash, log_.logIndex);
            return Verdict.Merged;
        }
        lastTripTx = txKey;
        // forge-lint: disable-next-line(unsafe-typecast) -- block timestamps fit in uint64.
        lastTripAt = uint64(block.timestamp);
        uint256 tripId = ++trips;
        emit Tripped(tripId, reason_, log_.chainId, log_.txHash, log_.logIndex);

        uint256 n = _chainIds.length;
        for (uint256 i; i < n; ++i) {
            uint256 chainId = _chainIds[i];
            ChainConfig storage c = _chains[chainId];
            uint256 count = c.tokens.length;
            if (c.guardian == address(0) || count == 0) continue;
            SYSTEM.requestCallbackV_1_0(
                ISystemContract.CallbackConfiguration_V_1_0({
                    chainId: chainId,
                    recipient: c.guardian,
                    gasLimit: callbackGasLimit(count),
                    // First argument is a placeholder the network overwrites with this contract's address.
                    payload: abi.encodeCall(Guardian.sweep, (address(0), tripId, c.tokens))
                })
            );
            emit SweepRequested(tripId, chainId, c.guardian, count);
        }
        return Verdict.Tripped;
    }

    function _setMoveSubscriptions(uint256 chainId_, address token_, bool on_) private {
        uint256 hot = uint256(uint160(HOT));
        if (on_) {
            SYSTEM.subscribe(chainId_, token_, TRANSFER_TOPIC_0, hot, REACTIVE_IGNORE, REACTIVE_IGNORE);
            SYSTEM.subscribe(chainId_, token_, APPROVAL_TOPIC_0, hot, REACTIVE_IGNORE, REACTIVE_IGNORE);
        } else {
            SYSTEM.unsubscribe(chainId_, token_, TRANSFER_TOPIC_0, hot, REACTIVE_IGNORE, REACTIVE_IGNORE);
            SYSTEM.unsubscribe(chainId_, token_, APPROVAL_TOPIC_0, hot, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
    }
}
