# Tripwire

**One stolen key shouldn't cost you every chain.**

Tripwire watches a hot wallet's tokens on Base, Ethereum and Unichain (Sepolia for now). The first outgoing transfer or
approval you didn't pre-clear trips it, and a Reactive Network contract sweeps every approved token on **all three
chains** to your own cold address. The contract that moves your tokens can pay exactly one address, yours, and only
when the call comes from your own reactive contract.

Built for the Reactive Omni Buildathon, track *Set It and Forget It*.

## The problem

A drained wallet rarely loses everything in one transaction. Drainer kits pull token after token with an approval the
victim signed, and key sweepers empty one chain, then the next. Between the first loss and the last there are seconds
to minutes, and nobody is watching. Tripwire is the thing watching: it reacts to the first bad move and gets
everything else out of reach.

## How it works

```
  Base Sepolia            Ethereum Sepolia          Unichain Sepolia
  ┌───────────────┐       ┌───────────────┐         ┌───────────────┐
  │ ERC-20s       │       │ ERC-20s       │         │ ERC-20s       │
  │ Transfer/     │       │ Transfer/     │         │ Transfer/     │
  │ Approval      │       │ Approval      │         │ Approval      │
  │ from HOT      │       │ from HOT      │         │ from HOT      │
  │ Intent, Panic │       │ Intent, Panic │         │ Intent, Panic │
  └──────┬────────┘       └──────┬────────┘         └──────┬────────┘
         │ logs (topic1 = HOT / cosigner)                  │
         └──────────────┬────────┴─────────────────────────┘
                        ▼
         Reactive Network (Lasna) ─ TripwireReactive.react()
         ┌───────────────────────────────────────────────────┐
         │ dedupe (chain, tx, log) ─ COLD / trusted? ─ under │
         │ threshold? ─ live intent? ─ otherwise TRIP        │
         │ TRIP: one requestCallbackV_1_0 per chain          │
         └──────┬───────────────────┬────────────────────┬───┘
                ▼                   ▼                    ▼
         callback proxy       callback proxy       callback proxy
                │                   │                    │
         Guardian.sweep()     Guardian.sweep()     Guardian.sweep()
         HOT ──transferFrom──▶ COLD, for every approved token, on every chain
```

1. **Origin.** `TripwireReactive` subscribes, per chain and per registered token, to `Transfer` and `Approval` with
   `topic1 = HOT`; to `Intend` from the chain's `Intent` contract with `topic1 = cosigner`; and to `Panic` from the
   chain's `PanicButton` with `topic1 = HOT` or the cosigner. Nothing else reaches it, so nobody can make it pay for
   spam events.
2. **Reactive.** `react()` (system contract only) decides per log:

   | Log | Clears when | Trips when |
   |---|---|---|
   | `Transfer(HOT → to)` | `to` is COLD or trusted; amount ≤ token threshold; a live cosigner intent covers it | anything else |
   | `Approval(HOT, spender)` | spender trusted; value 0; ≤ threshold; covered by an intent | anything else, e.g. a phishing approval |
   | `Approval(HOT, Guardian)` | value ≥ 2^128 | below it: the guard is being revoked |
   | `Panic(caller)` | | caller is HOT or the cosigner |
   | `Intend(cosigner, token, to, amount, expiry)` | stores an intent (max 1 day) | |

   Every log is handled once (key = chain id, tx hash, log index), and one origin transaction trips at most once, so
   a multicall drain costs one trip, not ten.
3. **Destination.** On a trip, every configured chain gets a callback to `Guardian.sweep(tripId, tokens)`. For each
   token the Guardian moves `min(balanceOf(HOT), allowance(HOT, Guardian))` from HOT to COLD and emits
   `Swept(tripId, token, amount)`. A token that reverts, burns gas, returns false or isn't a contract is skipped; the
   rest still move.

The sweep's own `Transfer(HOT → COLD)` logs come back to `react()` and clear (COLD is always trusted), so the loop
settles by itself. That path is tested.

## Contracts

| Contract | Chain | What it does |
|---|---|---|
| [`TripwireReactive`](src/TripwireReactive.sol) | Reactive (Lasna) | Subscriptions, rules, intents, dedupe, callback requests |
| [`Guardian`](src/Guardian.sol) | each destination | `sweep()`: HOT → COLD only; proxy + Tripwire id only; replay-safe |
| [`Intent`](src/Intent.sol) | each origin | `intend(token, to, amount, expiry)`: pre-clears one legit payment |
| [`PanicButton`](src/PanicButton.sol) | any watched chain | `panic()`: sweep everything now |
| [`MockERC20`](src/mocks/MockERC20.sol), [`Drainer`](src/mocks/Drainer.sol) | origin, demo only | test tokens and a demo approval drainer |

## Safety properties (and the tests that hold them)

`forge test`: **54 tests** (38 unit and scenario, 11 fuzz at 512 runs each, 5 invariants at 128 runs × 64 calls).

- **Only COLD ever receives.** `COLD` is immutable and is the only recipient in the code. Fuzzed over random
  hot/cold/amounts (`testFuzz_onlyColdEverReceives`) and held as an invariant across random drains, approvals,
  intents, panics, replays and forged calls (`invariant_guardianOnlyPaysCold`, `invariant_coldIsExplained`).
- **Only the proxy carrying Tripwire's id can sweep.** `onlyServiceProvider` (caller is the callback proxy) plus
  `onlyCallbackSender` (the network-injected first argument is our reactive contract). Fuzzed for any direct caller and
  any other reactive sender; invariant `invariant_noForgedSweep`.
- **Replays are no-ops.** Each trip id is handled once; a second trip on the same state moves nothing
  (`test_replay_isNoOpEvenWithNewFunds`, `invariant_replayIsNoOp`).
- **Intents expire and are used up.** `testFuzz_intent_expiryHonoured`, `testFuzz_intent_amountCap`, and intents only
  count from the cosigner, on their own chain, token and recipient.
- **Allowlist and thresholds.** `testFuzz_threshold`, `test_transfer_toCold_orTrusted_neverTrips`,
  `test_approval_rules`.
- **Dedupe.** Same log twice trips once; same tx with three Transfer logs trips once
  (`test_dedupe_*`, `test_coalesce_oneTripPerOriginTx`).
- **Hostile tokens can't block a sweep**: no-return (USDT-style), false-return, reverting, gas-burning and
  return-bomb tokens, re-entrancy (`test_weirdTokens_skippedOthersStillSwept`, `test_reentrancy_cannotSweepAgain`).
- **A sweep never runs out of gas and undoes itself.** Each token call is capped at 100k gas and a token is only
  attempted with 330k left, so a short gas limit skips the tail instead of reverting what already moved
  (`test_lowGas_skipsTailButNeverRevertsMovedTokens`).

The loop itself is simulated in-process (`test/utils/OmniSim.sol`): recorded origin logs are matched against the
recorded subscriptions, delivered to `react()` as the system contract, and the requested callbacks are delivered
through a mock proxy that injects the sender and holds back gas the way the real one does.

## Gas and cost (measured in tests; live numbers go in the tables below)

| Step | Gas | Cost |
|---|---|---|
| `Guardian.sweep`, 1 / 3 / 8 / 16 tokens (cold accounts) | 60k / 130k / 305k / 584k | budget asserted: 45k + 40k per token |
| Callback gas limit requested | 650k + 60k per token | unused gas isn't billed |
| `react()` that trips (3 chains × 3 tokens) | ~162k | Lasna fee = basefee × (gas + 100k) ≈ 0.026 lREACT at 100 gwei |
| `react()` that clears (e.g. HOT → COLD) | ~29k | ≈ 0.013 lREACT |
| Deploy `TripwireReactive` | ≈4.1M in tests (incl. 9 subscriptions to a mock) | ≈ 0.4 lREACT at 100 gwei |
| Deploy `Guardian` / `Intent` / `PanicButton` | 755k / 214k / 85k | fractions of a cent on L2 Sepolias |

## Threat model and honest limits

**Defends against:** approval drainers that pull token by token; key sweepers that move asset by asset or chain by
chain; a thief revoking the Guardian's approval first (the revoke trips); fake events (only subscribed contracts and
topics are delivered); forged or replayed callbacks.

**Does not defend against, and says so:**

- **The first move lands.** Tripwire reacts to an on-chain event, so the transfer that trips it has already happened.
  A one-transaction multicall drain with the stolen key takes everything it touches in that one transaction before any
  reaction exists. Tripwire limits the damage to that first transaction and saves everything else, on every chain.
- **Phishing approvals are caught before the pull, permits are not.** An `approve()` to an unknown spender trips
  Tripwire before the drainer's pull lands, if the pull comes in a later block. A signed `permit` used in the same
  transaction as the pull is the case above.
- **Reaction time is a race.** The sweep lands about one Reactive block plus one destination block after the origin
  event. A drainer pulling the next token in the very next block may still win that token. Latency numbers are in the
  table below.
- **Only approved ERC-20s.** Native ETH emits no log and can't be pulled by a contract; NFTs are out of scope for now.
  A token you didn't register and approve isn't watched or swept.
- **The cosigner matters.** Intents and panic come from the cosigner. If the cosigner is the hot key itself, a thief
  can pre-clear their own transfer. Use a second key (a phone wallet) for real protection.
- **False positives cost a trip home.** A payment you forgot to pre-clear moves everything to COLD. That is the
  failure mode by design: safe, a little annoying.
- **Funding.** A reactive contract or Guardian in debt goes silent. Keep both funded (`depositTo`), and watch them.
- **Owner of the reactive contract** can change tokens, thresholds, trusted addresses and Guardians on Reactive
  Network. It can't redirect funds: every Guardian pays only COLD. Keep that key off the hot wallet too.

## Why Reactive and not a keeper bot

Honestly: a well-run bot with its own RPC nodes can do the same job. What Reactive changes is who has to keep it
running and who holds power:

- **No server, no keeper key.** A bot needs a machine that never sleeps, RPC endpoints for three chains, and a hot key
  with gas on each chain. Tripwire is three contracts and two deposits; nothing of yours runs off-chain.
- **The trigger is on-chain and auditable.** The rules are in `react()`, and anyone can read why a sweep happened
  from the `Tripped` and `Observed` events.
- **Cross-chain fan-out is one call per chain** from the same reaction: a trip on Unichain sweeps Base and Ethereum
  too, without a bot watching three mempools.
- **What a bot does better:** it can watch the mempool and front-run a pending drain, which Tripwire can't (it reacts
  to included logs). For high-value wallets, use both.

## Deploy

Needs Foundry, one deployer key with Sepolia ETH and lREACT, the HOT key (only to approve the Guardian), and the
addresses of COLD and the cosigner. The order breaks the reactive ↔ Guardian address cycle the way the Reactive docs
suggest: reactive contract first, Guardians with its address, then wire them back.

```bash
git clone --recursive <this repo> && cd tripwire && forge test
export PRIVATE_KEY=... HOT=0x... COLD=0x... COSIGNER=0x...
export BASE_RPC=https://sepolia.base.org ETH_RPC=https://ethereum-sepolia-rpc.publicnode.com \
       UNI_RPC=https://sepolia.unichain.org LASNA_RPC=https://lasna-rpc.rnk.dev/

# 1. each origin chain: Intent + PanicButton (CREATE2, same address everywhere) and demo tokens
for RPC in $BASE_RPC $ETH_RPC $UNI_RPC; do
  forge script script/DeploySignals.s.sol --rpc-url $RPC --broadcast
  forge script script/DeployMocks.s.sol --rpc-url $RPC --broadcast   # demo only
done
export INTENT=0x... PANIC=0x... TOKENS=0x...,0x...,0x...

# 2. Lasna: the reactive contract, funded with 2 lREACT
CHAIN_IDS=84532,11155111,1301 INTENTS=$INTENT,$INTENT,$INTENT PANICS=$PANIC,$PANIC,$PANIC FUND=2ether \
  forge script script/DeployReactive.s.sol --rpc-url $LASNA_RPC --broadcast
export TRIPWIRE=0x...

# 3. each destination chain: Guardian, plus callback reserves via depositTo on that chain's proxy
for RPC in $BASE_RPC $ETH_RPC $UNI_RPC; do
  TRIPWIRE=$TRIPWIRE FUND=0.002ether forge script script/DeployGuardian.s.sol --rpc-url $RPC --broadcast
done

# 4. Lasna, once per chain: guardian + tokens (+ optional THRESHOLDS, TRUSTED)
CHAIN_ID=84532 GUARDIAN=0x... forge script script/Configure.s.sol --rpc-url $LASNA_RPC --broadcast

# 5. each origin chain, signed by HOT: approve that chain's Guardian (max) for every token
HOT_PK=... GUARDIAN=0x... forge script script/Arm.s.sol --rpc-url $BASE_RPC --broadcast

# top up later (Lasna: system contract; elsewhere: callback proxy)
TARGET=0x... AMOUNT=1000000000000000000 forge script script/Fund.s.sol --rpc-url $LASNA_RPC --broadcast
```

Pre-clear a payment (from the cosigner), press panic, or run the demo attacks:

```bash
cast send $INTENT "intendFor(address,address,uint256,uint64)" $TOKEN $TO $AMOUNT 900 --rpc-url $RPC --private-key $COSIGNER_PK
cast send $PANIC "panic()" --rpc-url $RPC --private-key $COSIGNER_PK
MODE=deploy|phish|pull|sweep forge script script/Drainer.s.sol:DrainerScript --rpc-url $RPC --broadcast
```

## Deployed (Lasna + Sepolias)

| Contract | Chain | Address |
|---|---|---|
| TripwireReactive | Lasna 5318007 | _tbd_ |
| Guardian | Base Sepolia 84532 | _tbd_ |
| Guardian | Ethereum Sepolia 11155111 | _tbd_ |
| Guardian | Unichain Sepolia 1301 | _tbd_ |
| Intent / PanicButton | all three | _tbd_ |

## Loops on-chain

| # | Scenario | Origin tx | Reactive tx | Callback txs (Base / Eth / Uni) |
|---|---|---|---|---|
| 1 | Approval drain on Base | _tbd_ | _tbd_ | _tbd_ |
| 2 | Key sweeper starting on Unichain | _tbd_ | _tbd_ | _tbd_ |
| 3 | Panic from the cosigner on Ethereum Sepolia | _tbd_ | _tbd_ | _tbd_ |
| 4 | Pre-cleared payment (no trip) | _tbd_ | _tbd_ | none |

## Latency (origin block → sweep included)

| Scenario | Runs | p50 | p95 | Notes |
|---|---|---|---|---|
| _tbd_ | | | | Base Sepolia uses 200 ms blocks; timestamps, not block counts |

## Notes on the Omni API

Written against [reactive-lib-omni](https://github.com/Reactive-Network/reactive-lib-omni) (`3ade0dc`):
`AbstractReactive` (system contract `0x8888…8888`, `onlySystem`, `REACTIVE_IGNORE`), `AbstractCallback`
(`onlyServiceProvider` for the proxy, `onlyCallbackSender` for the injected first argument),
`SYSTEM.requestCallbackV_1_0`. On Omni the address injected into the callback is the **reactive contract's own
address** (no separate ReactVM id), and there is no `vm` flag: the constructor subscribes directly, and
`react()` runs on Reactive Network with ordinary persistent state. `onlyCallbackSender` checks only the injected
address, so a callback method needs `onlyServiceProvider` as well (the Guardian uses both). The proxy holds back
`_extraGas + _maxChargeGas` from the requested gas limit before calling the recipient (read 2026-11-08: 150k + 50k on
Ethereum Sepolia, 80k + 50k on Base and Unichain Sepolia); the requested limit covers the largest.

## License

MIT
