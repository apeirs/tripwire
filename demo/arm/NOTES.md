# Arm page (`demo/arm/`)

A static page that sets up, arms and manages a Tripwire guard from the wallet in your browser (`window.ethereum`:
MetaMask, Rabby, …). No build step: plain JS modules, `viem@2.21.54` from cdn.jsdelivr.net, and the contracts' ABIs
and bytecode from Foundry's `out/` (`contracts.js`).

## README section (paste under "Watching it: the demo page")

### Arming it from a browser: the arm page

[`demo/arm/`](demo/arm/) does the Deploy steps above without a terminal. Connect a wallet and either open an
existing guard (its TripwireReactive address) or **set up a new one**: enter HOT, COLD and the cosigner, tick the
chains and tokens, and the page lists every transaction in plain words before you sign it. In order: Intent and
PanicButton where they are missing (CREATE2, the same address everywhere), the Tripwire contract on Reactive Network,
then per chain a Guardian, its callback reserves, `setGuardian` and `addToken`, and finally HOT's approvals. A step
that needs a different signer (owner or HOT) waits until you switch accounts in the wallet, and the wallet is switched
to each step's chain for you.

For a guard that exists, the page shows what is armed (per chain: Guardian checks, reserves and debt, each token's
HOT and COLD balance, threshold and approval) and offers only what is missing: "Arm Base: 3 approvals", or "Finish
setup" for everything at once. It also has:

- **Panic** (HOT or cosigner), on any chain with a PanicButton;
- **Pre-clear a payment** (cosigner): `Intent.intendFor`, with the live pre-clears listed;
- **Rules** (owner): watch or stop watching a token, thresholds, trusted addresses, merge window, hand over ownership;
- **Reserves** (any account): top up Tripwire or a Guardian, settle debt;
- **Disarm a chain**: the owner unsets the Guardian first, then HOT revokes, so the revokes don't trip;
- **History**: every trip by id with each chain's sweep (`Guardian.handled`), amounts for recent ones.

```bash
cd demo && python3 -m http.server 8000
# http://localhost:8000/arm/                 testnet config (demo/config.json)
# http://localhost:8000/arm/?net=mainnet     demo/config.mainnet.json
# http://localhost:8000/arm/?tripwire=0x…    open a guard directly; ?config=<file in demo/> for any other config
```

## How it reads the config

- `demo/config.json` by default, `?net=mainnet` → `config.mainnet.json`, `?config=X` → `demo/X`. Nothing is
  hard-coded per network: the Reactive chain is `lasnaChainId` (or `reactiveChainId`), the protected chains are the
  `networks` entries with a `callbackProxy`, and each network's `rpc`, `explorer`, `name`, `short` and `color` are
  used as they are. Optional per network: `intent` and `panic` (otherwise the CREATE2 addresses with
  script/DeploySignals.s.sol's default salt), `tokens` (suggested in the new-guard form, next to Circle's USDC),
  `currency`. Optional top level: `reactiveFund`, `guardianFund` (form defaults; otherwise 2 (l)REACT testnet / 1
  REACT mainnet, and 0.002 per Guardian).
- Which guard: `?tripwire=` > the one this browser set up or opened last (localStorage) > `tripwire` in the config.
  An empty or placeholder `tripwire` shows "No Tripwire deployed yet" and the new-guard form; an address without
  code shows "No contract at … on <chain>".
- All reads go to the config's RPCs, so the page shows a guard without a wallet. The wallet only signs.
- Mainnet configs (Reactive 1597) get a red "Mainnet" pill and a "real funds" note in every transaction dialog.

## Verified (2026-11-08)

`demo/arm/test/e2e.sh`: three plain anvils (Base Sepolia 84532, Unichain Sepolia 1301, Lasna 5318007) with the mock
system contract and callback proxies etched at the real addresses, anvil's public dev accounts only, no public
network. The repo scripts deploy the demo tokens and Base's Intent/PanicButton; `tools/localnet/relay.mjs` stands in
for Reactive Network. `test/e2e.mjs` drives the page in headless Chromium with an injected EIP-1193 wallet (it sends
from the selected unlocked anvil account, and switches chains and accounts the way a wallet does), and checks every
flow on chain with `cast`. 66 checks pass:

1. Both real configs (testnet, mainnet) show the not-deployed state and read no chain.
2. **Guard B, set up entirely from the page** (21 transactions, owner = cosigner, HOT signs only the approvals):
   Intent + PanicButton deployed on Unichain at the same CREATE2 address as Base's, Tripwire deployed with the right
   HOT/COLD/cosigner/owner, both Guardians obey it, 3 tokens watched and approved max per chain. A phishing approval
   from HOT then trips it and both chains are swept to COLD; the history shows trip #1 swept on both.
3. **Guard A, deployed by the scripts (DeployReactive, DeployGuardian, Configure; no Arm.s.sol)**: the page shows
   "not armed yet, 6 transactions", arms Base from its card, then "Finish setup" arms Unichain (the wallet is switched
   to Unichain), no trip. Cosigner pre-clears 50 tUSD to a payee; HOT pays it; no trip. Cosigner panics on Unichain;
   both chains swept (950 tUSD left after the payment, all else 1,000), history with amounts. Owner trusts an
   address, sets the merge window to 60 s and a threshold; an owner action started from HOT waits for the owner and
   sends nothing. A Guardian top-up adds exactly 0.02 to its reserves. Disarm Base: Guardian unset, all 3 approvals
   0, no trip, HOT keeps new funds. "Finish setup" re-arms Base with a new Guardian.
4. Every screenshot: nothing wider than the viewport (each element's right edge is measured, since the page clips
   horizontal overflow); no page errors. Desktop 1280 px, phone 390 px, dark and light.

`forge test`: 69 passed, 5 skipped (the fork tests, as before). No contract changed.

Run it again: `demo/arm/test/e2e.sh` (about a minute; needs anvil, forge, node and Playwright with Chromium). After a
contract change: `forge build && node demo/arm/tools/build-contracts.mjs` (`--check` fails if contracts.js is stale;
e2e.sh runs the check).

Screenshots in `shots/`: `00-*-not-deployed`, `01-new-guard-form(-phone)`, `02-review-transactions(-phone)`,
`03-armed`, `04-scripted-guard-not-armed(-phone)`, `05-after-panic(-phone, -light)`, `06-disarm-review`,
`07-after-disarm`, `08-rearmed`.

## Limits (what the contracts or the setup don't allow)

- **One guard = one HOT, fixed.** HOT, COLD, the cosigner and the chain list of a TripwireReactive are immutable, and
  each Guardian is bound to one Tripwire, HOT and COLD. Changing any of them means a new guard (the page's form);
  only tokens, thresholds, trusted addresses, Guardians and the merge window can change.
- **No index of guards.** Nothing on chain maps HOT to its Tripwire, so the page finds a guard by its address (link,
  config, or what this browser remembers). A user who loses it can look up their deploy transaction.
- **Disarm needs the owner.** Revoking the Guardian's approval while Tripwire still points at it trips
  `GuardianRevoked` and sweeps everything (by design). The page therefore unsets the Guardian first; with HOT alone you
  can't disarm quietly. The page offers no "revoke while armed" button.
- **The owner is powerful.** It can trust any address, so if the owner is HOT, a thief with HOT can switch the guard
  off. The page warns (new-guard form, dialog, a red banner on the guard) and offers "Hand over ownership".
- **Trusted addresses aren't enumerable on chain** (a mapping); the page lists them from `TrustedSet` events in the
  scanned window (6 h by default, `?history=<hours>`), and any address can be checked by trusting/untrusting it.
  Live pre-clears likewise come from `IntentSet` events in that window, with the remaining amount read from
  `intents()`.
- **History depth.** Trips are listed by id from `trips()` (last 20) with `Guardian.handled(id)` per chain, which needs
  no log range; the reason, time and merged moves come from Reactive events in the window, the swept amounts from at
  most 10 × `maxRange` blocks of each Guardian's logs (public RPCs cap log ranges).
- **Verified on anvil, not on a live network.** The relay and mock system contract stand in for Reactive Network (as
  in tools/localnet), and the injected wallet is a test shim. Not yet exercised with MetaMask itself, e.g.
  `wallet_addEthereumChain` for Lasna (the page sends name, RPC, explorer and lREACT as currency), or the live system
  contract's `debt()`/`reserves()` reads (they fall back to "–" if missing).
- **Reactive deploy cost.** Deploying TripwireReactive from the page subscribes for real (about 4.25M gas plus the
  funding); the dialog shows the funding amount but no gas estimate.
- **CDN dependency.** viem loads from cdn.jsdelivr.net (pinned 2.21.54). Offline, the page doesn't start.
- Max 16 tokens per chain and 8 chains (contract limits), enforced with a readable message.
