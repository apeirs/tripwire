# Tripwire

**One stolen key shouldn't cost you every chain.**

Tripwire guards a hot wallet's ERC-20s on Base, Unichain and Ethereum. It runs on **Reactive mainnet**, guarding
Base and Unichain (demo tokens; Circle's real USDC works the same and is fork-tested); the same scripts deploy on the
Lasna testnet with the three Sepolias. When an outgoing transfer
or approval leaves the wallet that isn't to a trusted address, isn't under your threshold and wasn't pre-cleared,
a reactive contract on Reactive Network trips and asks a Guardian on **every guarded chain** to move every
approved token to your cold address. A Guardian can pay exactly one address, yours, and only on a callback from
your own reactive contract.

Built for the Reactive Omni Buildathon, track *Set It and Forget It*.

## The problem

A drained wallet rarely loses everything in one transaction. Drainer kits pull token after token with an approval
the victim signed, and key sweepers empty one chain, then the next. Between the first loss and the last there are
seconds to minutes, and nobody is watching. Tripwire watches: it reacts to the first move it can't explain and puts
everything else out of reach, on every chain at once.

## How it works

```
  Base                    Ethereum                  Unichain        (or their Sepolias)
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
         Reactive Network (mainnet or Lasna) ─ TripwireReactive.react()
         ┌───────────────────────────────────────────────────┐
         │ dedupe (chain, tx, log) ─ COLD / trusted? ─ under │
         │ threshold? ─ live intent? ─ otherwise TRIP        │
         │ TRIP: one requestCallbackV_1_0 per chain, unless  │
         │ it merges into the last trip (same tx / window)   │
         └──────┬───────────────────┬────────────────────┬───┘
                ▼                   ▼                    ▼
         callback proxy       callback proxy       callback proxy
                │                   │                    │
         Guardian.sweep()     Guardian.sweep()     Guardian.sweep()
         HOT ──transferFrom──▶ COLD, for every approved token, on every chain
```

1. **Origin.** `TripwireReactive` subscribes, per chain and per registered token, to `Transfer` and `Approval` with
   `topic1 = HOT`; to `Intend` from that chain's `Intent` contract with `topic1 = cosigner`; and to `Panic` from that
   chain's `PanicButton` with `topic1 = HOT` or the cosigner. No other log reaches it, so strangers can't make it
   spend gas.
2. **Reactive.** `react()` (callable only by the system contract) decides per log, in this order:

   | Log | Clears when | Trips when |
   |---|---|---|
   | `Approval(HOT, Guardian)` | value ≥ 2^128 | value below that: someone is revoking the guard |
   | `Transfer(HOT → to)` | `to` is COLD or trusted; or amount ≤ the token's threshold; or a live cosigner intent covers it | anything else |
   | `Approval(HOT → spender)` | spender is COLD or trusted; or value is 0; or ≤ threshold; or covered by an intent | anything else, e.g. a phishing approval |
   | `Panic(caller)` | never | caller is HOT or the cosigner |
   | `Intend(cosigner, token, to, amount, expiry)` | stores an intent for that chain, token and recipient (at most 1 day; used up as transfers arrive) | never |

   Each log is handled once (key = chain id, tx hash, log index). Every decision is logged as
   `Observed(chain, topic0, counterparty, amount, verdict, tx, logIndex)`, so each verdict names the exact origin log;
   a trip also emits `Tripped(tripId, reason, chain, tx, logIndex)` and one `SweepRequested` per chain.

   **Trips merge.** A move that would trip but comes from the same origin transaction as the last trip, or less than
   `tripCooldown` (default 5 minutes) after it, requests no new sweep: its verdict is `Merged` and it emits
   `TripMerged(tripId, reason, chain, tx, logIndex)`, so it is on record but costs no callbacks. A multicall that
   moves three tokens, or a thief who sends approval after approval with the hot key, costs one sweep per chain per
   window instead of one per transaction. The window runs from the trip that fired and merged moves never extend it,
   so the first untrusted move after it trips again (a thief who waits it out, or new funds pulled later, get a new
   sweep). A `Panic` from the cosigner always fires, window or not; a `Panic` from the hot key is merged like the hot
   key's other moves, since a thief holds that key too. The clock is Reactive Network's `block.timestamp`: a
   `LogRecord` carries no origin timestamp, and block numbers from different chains can't be compared, while one trip
   sweeps every chain. The owner sets the window with `setTripCooldown` (0 to 1 day; 0 merges same-tx trips only).
3. **Destination.** On a trip, each chain with a Guardian and at least one token gets a callback to
   `Guardian.sweep(tripId, tokens)`. For each token the Guardian moves `min(balanceOf(HOT), allowance(HOT, Guardian))`
   from HOT to COLD and emits `Swept`. A token that reverts, burns gas, returns false or isn't a contract is skipped
   (`Skipped` with the reason); the rest still move. `SweepDone(tripId, swept, skipped, unhandled)` closes each sweep:
   `skipped` counts the `Skipped` events, `unhandled` the tokens that got neither event (past `MAX_TOKENS` = 32, or
   after the sweep stopped short of gas), and the three add up to the list length. A trip id is handled once per
   Guardian.

The sweep's own `Transfer(HOT → COLD)` logs come back to `react()` and clear (COLD is always trusted), so the loop
settles by itself. That path is tested, including tokens that emit a fresh `Approval` when an allowance is spent.

## Contracts

| Contract | Chain | What it does |
|---|---|---|
| [`TripwireReactive`](src/TripwireReactive.sol) | Reactive Network (mainnet 1597 or Lasna) | Subscriptions, rules, intents, dedupe, callback requests |
| [`Guardian`](src/Guardian.sol) | each protected chain | `sweep()`: HOT → COLD only; callback proxy + Tripwire's address only; replay-safe |
| [`Intent`](src/Intent.sol) | each origin chain | `intend()` / `intendFor()`: pre-clears one payment or approval, max 1 day |
| [`PanicButton`](src/PanicButton.sol) | each origin chain | `panic()`: sweep everything now |
| [`MockERC20`](src/mocks/MockERC20.sol), [`Drainer`](src/mocks/Drainer.sol) | origin, demo only | demo tokens (on mainnet "Tripwire Demo Token A/B/C (worthless)", TDTA/TDTB/TDTC) and an approval drainer |

## Safety properties (and the tests that hold them)

`forge test`: **69 tests** (51 unit and scenario, 12 fuzz at 512 runs each, 6 invariants at 128 runs × 64 calls), plus
5 fork tests that run Circle's real USDC on forks of the three Sepolias and of Base and Unichain mainnet when asked
for (below).

- **Only COLD ever receives.** `COLD` is immutable and is the only recipient in the code. Fuzzed over random
  hot/cold/amounts (`testFuzz_onlyColdEverReceives`) and held as an invariant across random drains, approvals,
  intents, panics, replays and forged calls (`invariant_guardianOnlyPaysCold`, `invariant_coldIsExplained`).
- **Only the proxy, on behalf of our reactive contract, can sweep.** `onlyServiceProvider` (caller is the callback
  proxy) plus `onlyCallbackSender` (the network-injected first argument is our reactive contract). Fuzzed for any
  direct caller and any other reactive sender; invariant `invariant_noForgedSweep`.
- **Replays are no-ops.** Each trip id is handled once; a second trip on the same state moves nothing
  (`test_replay_isNoOpEvenWithNewFunds`, `invariant_replayIsNoOp`).
- **Intents expire and are used up.** `testFuzz_intent_expiryHonoured`, `testFuzz_intent_amountCap`; intents count
  only from the cosigner, on their own chain, token and recipient.
- **Allowlist and thresholds.** `testFuzz_threshold`, `test_transfer_toCold_orTrusted_neverTrips`,
  `test_approval_rules`.
- **Dedupe.** The same log twice trips once; one tx with three Transfer logs trips once
  (`test_dedupe_*`, `test_coalesce_oneTripPerOriginTx`).
- **Repeated trips can't burn the reserves.** Eight untrusted moves in separate transactions inside the window cost
  one sweep set and each emits `TripMerged` (`test_window_repeatedPhishingApprovals_oneSweepSet`); merged moves don't
  extend the window (`test_window_mergedMovesDontExtendIt`); the first move after it re-trips and sweeps new funds
  (`test_window_postWindowMove_newTrip`); the cosigner's panic fires inside it, the hot key's doesn't
  (`test_window_cosignerPanicStillFires`, `test_window_hotPanicMergesInsideWindow`); fuzzed over window and gap
  (`testFuzz_window_cooldown`). Invariant: outside a cosigner panic, sweeps are never requested twice within one
  window (`invariant_tripsRespectWindow`).
- **Hostile tokens can't block a sweep**: no-return (USDT-style), false-return, reverting, gas-burning and
  return-bomb tokens, re-entrancy (`test_weirdTokens_skippedOthersStillSwept`, `test_reentrancy_cannotSweepAgain`).
- **Real assets, at their own precision.** A USDC-like token (6 decimals, allowance spent down even when it is max,
  pause and blacklist) is guarded next to 18-decimal tokens through the whole loop: thresholds are raw units (5 USDC =
  `5000000`, one micro-USDC over trips), everything left is swept to the unit, the Guardian stays armed after the
  spend-down, and a paused token or a blacklisted vault is skipped while the rest moves (`test/Usdc.t.sol`). Circle's
  real FiatToken bytecode on forks of Base, Ethereum and Unichain Sepolia and of Base and Unichain mainnet: minted the
  way Circle mints, swept to COLD through the proxy, 62.7k gas (`FORK_TESTS=1 BASE_RPC=… ETH_RPC=… UNI_RPC=…
  BASE_MAINNET_RPC=… UNI_MAINNET_RPC=… forge test --mc UsdcForkTest -vv`, read-only).
- **A sweep never runs out of gas and undoes itself.** Each token call is capped at 100k gas and a token is only
  attempted with 330k left, so a short gas limit skips the tail instead of reverting what already moved
  (`test_lowGas_skipsTailButNeverRevertsMovedTokens`).

The loop is simulated in-process (`test/utils/OmniSim.sol`): recorded origin logs are matched against the recorded
subscriptions, delivered to `react()` as the system contract, and the requested callbacks are delivered through a
mock proxy that injects the sender and holds back gas the way the real one does. `test/Loop.t.sol` runs the four demo
scenarios end to end; `test/DemoTrace.t.sol` runs the demo story and prints its raw logs for the demo page.

## Gas and cost (measured in tests; live numbers go in the tables below)

| Step | Gas | Cost |
|---|---|---|
| `Guardian.sweep`, 1 / 3 / 8 / 16 tokens (cold accounts) | 60k / 130k / 305k / 584k | budget asserted: 45k + 40k per token |
| Callback gas limit requested | 650k + 60k per token | unused gas isn't billed |
| `react()` that trips (3 chains × 3 tokens) | ~168k | Reactive fee = basefee × (gas + 100k) ≈ 0.027 REACT at 100 gwei (mainnet and Lasna alike), plus one callback per chain |
| `react()` that clears (e.g. HOT → COLD) | ~29k | ≈ 0.013 REACT |
| `react()` that merges into the last trip | ~34k | ≈ 0.013 REACT, no callbacks |
| Deploy `TripwireReactive` | ≈4.25M in tests (incl. 9 subscriptions to a mock); 3.34M simulated on Reactive mainnet (2 chains, before tokens) | ≈ 0.33-0.43 REACT at 100 gwei |
| `Guardian.sweep` of Circle's real USDC (fork test) | 62.7k | same budget |
| Deploy `Guardian` / `Intent` / `PanicButton` | ≈763k / 214k / 85k | fractions of a cent on Base and Unichain (0.006 / 0.0015 gwei on 2026-11-08) |

Worst case under abuse: a thief holding the hot key can make it fire at most once per window (default 5 minutes),
i.e. at most 12 trips an hour, ≈ 0.32 REACT and 12 callbacks per chain an hour, plus ≈ 0.013 REACT per merged
move they pay origin gas to send. With `tripCooldown` = 0, every untrusted transaction is a full trip.

## Threat model and honest limits

**Defends against:** approval drainers that pull token by token; key sweepers that move asset by asset or chain by
chain; a thief revoking the Guardian's approval first (the revoke trips); fake events (only subscribed contracts and
topics are delivered, so a look-alike token can't reach it); forged or replayed callbacks.

**Does not defend against, and says so:**

- **The first move lands.** Tripwire reacts to an included log, so the transfer that trips it has already happened.
  A one-transaction multicall drain with the stolen key takes everything it touches in that transaction before any
  reaction exists. Tripwire limits the loss to that transaction and saves everything else, on every chain.
- **Phishing approvals are caught before the pull, permits are not.** An `approve()` to an unknown spender trips
  Tripwire before the drainer pulls, if the pull comes in a later transaction. A signed `permit` used in the same
  transaction as the pull is the case above.
- **Reaction time is a race.** A sweep lands after the origin block, a Reactive block and a destination block. A
  drainer pulling the next token in the very next block may still win that token. Measured numbers are in the
  latency table below.
- **Only approved ERC-20s.** Native ETH emits no log and a contract can't pull it; NFTs are out of scope for now. A
  token you didn't register and approve isn't watched or swept.
- **The cosigner matters.** Intents and panic come from the cosigner. If the cosigner is the hot key itself, a thief
  can pre-clear their own transfer. Use a second key (a phone wallet).
- **False positives send everything home.** A payment you forgot to pre-clear moves all approved tokens to COLD:
  safe, a little annoying. Pre-clear the address that actually *receives* the tokens: a DEX swap usually moves them
  from HOT to a pool, not to the router you approved, so trust that pool or pre-clear it too.
- **The merge window is a trade-off.** Inside it, untrusted moves request no new sweep. A thief can trip Tripwire
  with a decoy, let the sweep land, and pull funds that reach HOT later in the same window; the first such move
  after the window re-trips. If a sweep failed (an unfunded Guardian, a dropped callback), moves inside the window
  don't retry it: press panic from the cosigner, which always fires. Outside it, a thief with the hot key can still
  make Tripwire fire once per window, so the reserves drain slowly instead of at once; watch the trips on the demo
  page and top up or rotate. A shorter `tripCooldown` re-arms sooner and spends more. The window runs on Reactive
  Network's clock, so a backlog of origin logs delivered late is judged by when it arrives. If the cosigner is the hot
  key, panic presses are never merged and the thief can spend that way.
- **Funding.** A reactive contract or Guardian in debt goes silent. Keep both funded (`depositTo`) and watch them
  (the demo page shows the reactive balance and each Guardian's callback debt).
- **Owner of the reactive contract** can change tokens, thresholds, trusted addresses, Guardians and the merge
  window on Reactive Network. It can't redirect funds: every Guardian pays only COLD. Keep that key off the hot wallet too.

## Why Reactive and not a keeper bot

A well-run bot with its own RPC nodes can do the same job. What Reactive changes is who keeps it running and who
holds power:

- **No server, no keeper key.** A bot needs a machine that never sleeps, RPC endpoints for three chains, and a hot
  key with gas on each chain. Tripwire is contracts and deposits; nothing of yours runs off-chain.
- **The trigger is on-chain and auditable.** The rules are in `react()`, and anyone can read why a sweep happened
  from the `Observed` and `Tripped` events.
- **Cross-chain fan-out is one callback per chain** from the same reaction: a trip on Unichain sweeps Base and
  Ethereum too, without a bot watching three chains.
- **What a bot does better:** it can watch the mempool and front-run a pending drain, which Tripwire can't (it reacts
  to included logs). For high-value wallets, use both.

## Deploy

Needs Foundry, one deployer key with gas on every chain (REACT on Reactive Network), the HOT key (only to approve the
Guardians), and the addresses of COLD and the cosigner. The order breaks the reactive ↔ Guardian address cycle the
way the Reactive docs suggest: reactive contract first, Guardians with its address, then wire them back. Mainnets and
testnets can't be mixed: `DeployReactive` and `Configure` refuse a Sepolia from Reactive mainnet and the reverse.

```bash
git clone --recursive <this repo> && cd tripwire && forge test
export PRIVATE_KEY=... HOT=0x... COLD=0x... COSIGNER=0x...

# Reactive mainnet + Base + Unichain (what runs now). base-rpc.publicnode.com, because mainnet.base.org refuses
# eth_getLogs and the demo page needs them.
export BASE_RPC=https://base-rpc.publicnode.com UNI_RPC=https://mainnet.unichain.org \
       REACTIVE_RPC=https://mainnet-rpc.rnk.dev/ IDS=8453,130
# Testnet instead: BASE_RPC=https://sepolia.base.org UNI_RPC=https://sepolia.unichain.org
#   REACTIVE_RPC=https://lasna-rpc.rnk.dev/ IDS=84532,1301 (add ETH_RPC / 11155111 for Ethereum Sepolia)

# 1. each origin chain: Intent + PanicButton (CREATE2, same address everywhere) and demo tokens
#    (on a mainnet: "Tripwire Demo Token A/B/C (worthless)", TDTA/TDTB/TDTC, open mint)
for RPC in $BASE_RPC $UNI_RPC; do
  forge script script/DeploySignals.s.sol --rpc-url $RPC --broadcast
  forge script script/DeployMocks.s.sol --rpc-url $RPC --broadcast   # demo only
done
export INTENT=0x... PANIC=0x... TOKENS=0x...,0x...,0x...

# 2. Reactive Network: the reactive contract, funded with 2 REACT (0.33 REACT of gas on mainnet)
CHAIN_IDS=$IDS INTENTS=$INTENT,$INTENT PANICS=$PANIC,$PANIC FUND=2ether \
  forge script script/DeployReactive.s.sol --rpc-url $REACTIVE_RPC --broadcast
export TRIPWIRE=0x...

# 3. each destination chain: Guardian, plus callback reserves via depositTo on that chain's proxy
#    (FUND defaults to 0.0001 ETH on a mainnet, ≈ 40 trips on Base; 0.005 on a testnet)
for RPC in $BASE_RPC $UNI_RPC; do
  forge script script/DeployGuardian.s.sol --rpc-url $RPC --broadcast
done
export G_BASE=0x... G_UNI=0x...

# 4. Reactive Network, once per chain: its Guardian + tokens (+ optional THRESHOLDS, TRUSTED). USDC=true adds
#    Circle's USDC on that chain (script/Chains.sol); USDC_THRESHOLD is in raw units, 6 decimals (1000000 = 1 USDC)
CHAIN_ID=${IDS%,*} GUARDIAN=$G_BASE forge script script/Configure.s.sol --rpc-url $REACTIVE_RPC --broadcast
CHAIN_ID=${IDS#*,} GUARDIAN=$G_UNI  forge script script/Configure.s.sol --rpc-url $REACTIVE_RPC --broadcast

# 5. each chain, signed by HOT: approve that chain's Guardian (max) for every token (same USDC=true as step 4;
#    it prints each token's symbol and decimals and stops on an address without code)
export HOT_PK=...
GUARDIAN=$G_BASE forge script script/Arm.s.sol --rpc-url $BASE_RPC --broadcast
GUARDIAN=$G_UNI  forge script script/Arm.s.sol --rpc-url $UNI_RPC  --broadcast

# top up later (Reactive Network: system contract; elsewhere: callback proxy)
TARGET=0x... AMOUNT=1000000000000000000 forge script script/Fund.s.sol --rpc-url $REACTIVE_RPC --broadcast
```

Rehearse the whole sequence locally first, mainnet chain ids included and nothing sent anywhere:
`NET=mainnet tools/localnet/run.sh` (below).

Pre-clear a payment (from the cosigner), press panic, or run the demo attacks:

```bash
cast send $INTENT "intendFor(address,address,uint256,uint64)" $TOKEN $TO $AMOUNT 900 --rpc-url $RPC --private-key $COSIGNER_PK
cast send $PANIC "panic()" --rpc-url $RPC --private-key $COSIGNER_PK
MODE=deploy|phish|pull|sweep forge script script/Drainer.s.sol:DrainerScript --rpc-url $RPC --broadcast
```

### A real asset: Circle's USDC

The token list is per chain: `TOKENS` (comma list, the demo tokens) plus, with `USDC=true`, Circle's USDC on that
chain, from `script/Chains.sol`:

| Chain | USDC (FiatToken v2, 6 decimals) |
|---|---|
| Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Unichain | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` |
| Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Ethereum Sepolia | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Unichain Sepolia | `0x31d0220469e10c4E71834a79b1f276d740d3768F` |

Addresses from [Circle's list](https://developers.circle.com/stablecoins/usdc-contract-addresses), checked on-chain
2026-11-08. The mainnet demo uses the worthless TDT tokens, so latency runs can re-mint them for free and no real value
sits behind a demo key; guarding real USDC is the same code path (fork tests above). To fund HOT on a testnet: [faucet.circle.com](https://faucet.circle.com), pick USDC and the network,
paste HOT's address. No account or sign-up (a reCAPTCHA only); 20 USDC per request, one request per address, network
and token every 2 hours. Nothing in the contracts depends on decimals: the Guardian moves raw amounts, thresholds are
raw units, and the demo page and `tools/measure.mjs` read `decimals()` and `symbol()` from each token.

## Watching it: the demo page

[`demo/`](demo/) is a static page (no build step, no dependencies) that reads the chains from public RPCs and shows
the loop as it happens: the watched move on the origin chain, the `Tripped` reaction on Reactive Network, and each Guardian's
sweep, with explorer links, block timestamps and the latency between steps. Verdicts link to their moves by origin
tx and log index, and moves merged into a trip are listed on its card. It also shows hot vs vault balances,
whether each Guardian is still approved, the reactive contract's REACT balance and each Guardian's callback debt.

```bash
cd demo && python3 -m http.server 8000
# mainnet: http://localhost:8000/?net=mainnet   ("tripwire" in demo/config.mainnet.json, or &tripwire=0x…)
# testnet: http://localhost:8000/?tripwire=0x<TripwireReactive>   (or set "tripwire" in demo/config.json)
# replay:  http://localhost:8000/?mock=1   (&speed=2, &instant=1)
```

Only the reactive contract's address is needed: HOT, COLD, the cosigner, chains, Guardians and tokens are read from
it. Base blocks (mainnet and Sepolia) carry millisecond timestamps; the other chains' only whole seconds, and the
page marks those latencies with "≈".

`?mock=1` replays [`demo/fixture.json`](demo/fixture.json), labelled on screen as simulated. Its logs were emitted by
these contracts in the Foundry simulator (`test/DemoTrace.t.sol`); its hashes and times are synthetic. Regenerate it
and check the page logic offline:

```bash
forge test --mt test_demoTrace -vv --json | node demo/tools/build-fixture.mjs > demo/fixture.json
node demo/tools/check.mjs   # signatures vs src/, topics and selectors vs cast, decoders, fixture replay
```

[`demo/STORYBOARD.md`](demo/STORYBOARD.md) is the shot list for the demo video.

## Recording the video

`tools/video/` turns the monitor page into the submission video (`demo/STORYBOARD.md` has the shot list). It records
the page headless at 1920x1080 (Playwright + Chromium), then ffmpeg adds a title card, captions from
`tools/video/captions.json` and an end card, and writes `tools/video/out/tripwire-demo.mp4` (H.264, yuv420p, 1920x1080,
under 3:00; `out/` and `work/` are git-ignored, and the intermediate webm is deleted after the build).

**Draft, from the simulated replay (works any time, no network, about 2.5 minutes):**

```bash
tools/video/make.sh --draft
```

Every frame carries a "DRAFT - simulated replay" stamp. It is for checking the cut, not for submitting.

**Final, from a live run:** the page records while you run the attack from a terminal, so it needs the live setup
from the Deploy section (`demo/config.mainnet.json` has the `tripwire` address) and the storyboard's "Before recording" steps.

```bash
cp tools/video/values.example.json tools/video/values.json   # fill REPO_URL and the measured latencies (see README "Latency")
tools/video/make.sh --live --mainnet --values tools/video/values.json  # records ?net=mainnet; waits up to 15 min for a trip
# in another terminal, at the "normal" caption: the cosigner intent + payment, then MODE=phish (STORYBOARD shots 4-5)
```

The recorder waits for the intent row, then the trip card, then "all chains swept", so the page scenes follow your
take. A final build **refuses to run while any `{{PLACEHOLDER}}` is left in the captions** (`REPO_URL`, `NETWORKS`,
`REACTIVE`, `LAT_LAST_SWEEP`, `RUNS`, `LAT_P50`, `LAT_P95`); fill them from the real runs, never from the replay fixture.
`--draft` builds anyway and leaves the placeholders visible.

Only the page scenes are recorded. Terminal and README shots (STORYBOARD 2, 4, 5, 7, 10) are not; cut them in separately
if you want them. Useful pieces on their own: `node tools/video/record.mjs [--live] [--speed 1.5] [--zoom 1.25] [--out DIR]`
(writes `raw.webm` and `scenes.json`) and `tools/video/build.sh [--draft] [--values FILE] [--keep]`.

## Deployed (Reactive mainnet + Base + Unichain)

| Contract | Chain | Address |
|---|---|---|
| TripwireReactive | Reactive mainnet 1597 | _tbd_ ([reactscan.net](https://reactscan.net)) |
| Guardian | Base 8453 | _tbd_ ([basescan.org](https://basescan.org)) |
| Guardian | Unichain 130 | _tbd_ ([uniscan.xyz](https://uniscan.xyz)) |
| Intent / PanicButton | Base and Unichain (same address) | _tbd_ |
| Demo tokens TDTA / TDTB / TDTC (worthless, open mint) | Base and Unichain (same address) | _tbd_ |

## Loops on-chain

| # | Scenario | Origin tx | Reactive tx | Callback txs (Base / Unichain) |
|---|---|---|---|---|
| 1 | Approval drain on Base | _tbd_ | _tbd_ | _tbd_ |
| 2 | Key sweeper starting on Unichain | _tbd_ | _tbd_ | _tbd_ |
| 3 | Panic from the cosigner on Unichain | _tbd_ | _tbd_ | _tbd_ |
| 4 | Pre-cleared payment (no trip) | _tbd_ | _tbd_ | none |

Explorer links: `https://reactscan.net/tx/<hash>`, `https://basescan.org/tx/<hash>`, `https://uniscan.xyz/tx/<hash>`
(addresses: `/address/<addr>`).

## Latency (origin block → sweep included)

<!-- measure:latency:begin (generated by tools/measure.mjs from docs/latency.csv; edits here are overwritten) -->
_Not measured yet: filled in by `node tools/measure.mjs --mainnet` after the deploy (see "Measuring it" below)._
<!-- measure:latency:end -->

### Measuring it

`tools/measure.mjs` (node, no dependencies; forge and cast on PATH) runs N trips end to end on the deployment and
writes the table above and [`docs/latency.csv`](docs/latency.csv) (one row per run and destination chain, with every
transaction hash). Per run it tops HOT up on the demo tokens, sends one untrusted move from HOT through
`script/Measure.s.sol` (keys from the environment, as in every script), then polls the origin chain, Reactive Network and each
Guardian for `Observed`/`Tripped` and `SweepDone`, with block timestamps and wall-clock times. It sets `tripCooldown`
to 0 for the session so the runs don't merge, and restores it afterwards, on errors, timeouts and Ctrl-C too.

```bash
node tools/measure.mjs --mainnet --dry-run             # the plan and what is missing; sends nothing
                                                       # (--mainnet: demo/config.mainnet.json; without it, Lasna)
export PRIVATE_KEY=... HOT_PK=...                      # owner (cooldown, mints) and HOT (the move)
node tools/measure.mjs --mainnet --runs 10 --origin all  # rotate the origin chain; --scenario approval|panic
node tools/measure.mjs --runs 3 --token USDC --amount 2 --refill   # trip on real USDC; COLD_PK sends it back each run
node tools/measure.mjs --fixture                       # the table code on demo/fixture.json (simulated), prints only
```

`tools/localnet/run.sh` runs all of it with no real transaction: anvil chains for Base Sepolia (forked, so Circle's
USDC is the real bytecode) and Unichain Sepolia, a third anvil as Lasna with the mock system contract, and
`tools/localnet/relay.mjs` standing in for Reactive Network. `NET=mainnet tools/localnet/run.sh` does the same with
mainnet chain ids, the mainnet callback-proxy addresses, the TDT demo tokens and a fork of Base mainnet (real USDC). It deploys with the scripts above, measures, and checks
the CSV, the table, the USDC sweep and the cooldown restore after a timeout and after Ctrl-C.

## Notes on the Omni API

Written against [reactive-lib-omni](https://github.com/Reactive-Network/reactive-lib-omni) (`3ade0dc`):
`AbstractReactive` (system contract `0x8888…8888`, `onlySystem`, `REACTIVE_IGNORE`), `AbstractCallback`
(`onlyServiceProvider` for the proxy, `onlyCallbackSender` for the injected first argument),
`SYSTEM.requestCallbackV_1_0`. On Omni the address injected into the callback is the **reactive contract's own
address** (no separate ReactVM id), and there is no `vm` flag: the constructor subscribes directly, and
`react()` runs on Reactive Network with ordinary persistent state. `onlyCallbackSender` checks only the injected
address, so a callback method needs `onlyServiceProvider` as well (the Guardian uses both). The proxy holds back
`_extraGas + _maxChargeGas` from the requested gas limit before calling the recipient (read 2026-11-08: 150k + 50k on
Ethereum and Ethereum Sepolia, 80k + 50k on Base and Unichain, mainnet and Sepolia); the requested limit covers the
largest.
`react()` reads `LogRecord.opCode` as the number of topics (3 for `Transfer`/`Approval`, 4 for `Intend`), as the
simulator does; the first live loop should be a `Transfer` or `Approval`, not a `Panic` (which doesn't check it).

## License

MIT
