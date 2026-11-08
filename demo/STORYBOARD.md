# Tripwire demo video: storyboard

Target length 2:40 (hard limit 3:00). Plain voice-over, or the same lines as captions if there's no voice. Every shot
is real testnet activity except the title card; the monitor page runs in LIVE mode. `?mock=1` is for rehearsing
the cut only: entries without on-chain transactions aren't scored, and the replay says on screen that it is simulated.

## Before recording

1. Everything in README "Deploy" is done on Base, Ethereum and Unichain Sepolia, and `forge test` is green.
2. `demo/config.json`: set `tripwire` to the TripwireReactive address. Add `labels` for the addresses you'll show,
   e.g. `{"0x<drainer>": "drainer", "0x<shop>": "shop"}`, so the page prints names instead of hex.
3. Serve the page: `cd demo && python3 -m http.server 8000`, open `http://localhost:8000/?lookback=5`.
   Check: every RPC dot is green, every Guardian allowance reads "armed", callback debt is 0, the Lasna balance shows.
4. Terminal with the env from README (`HOT_PK`, `ATTACKER_PK`, `COSIGNER_PK`, `INTENT`, `TOKENS`, RPCs) and a large font.
5. Fresh state: HOT holds 1,000 of each demo token on every chain (`DeployMocks`), vault empty, no trips yet.
   After a take, re-mint to HOT (`cast send $TOKEN "mint(address,uint256)" $HOT ...`) and re-arm if needed.
6. **Use one token in the phishing step** (`TOKENS=$TETH`). `MODE=phish` with three tokens sends three approval
   transactions, and each separate transaction is its own trip, so the page would show three trips where two
   sweep nothing.
7. Deploy the demo drainer on Base Sepolia from the attacker key and note `DRAINER`:
   `MODE=deploy forge script script/Drainer.s.sol:DrainerScript --rpc-url $BASE_RPC --broadcast`.

Layout: browser with the monitor on the left two thirds, terminal on the right third. Record the screen with ffmpeg
(`ffmpeg -f x11grab -framerate 30 -i :0.0 ...`), cut and caption with ffmpeg, keep it under 20 MB.

## Shots

| # | Time | On screen | Voice-over / caption | Produced by |
|---|---|---|---|---|
| 1 | 0:00-0:10 | Title card: "Tripwire: one stolen key shouldn't cost you every chain." Below it, the monitor in LIVE mode, three chains, balances all in the hot wallet. | "This is Tripwire. It watches a hot wallet on three chains and, the moment something it can't explain leaves the wallet, it moves everything else to your own cold address. On every chain." | page, `?lookback=5` |
| 2 | 0:10-0:30 | README "The problem" paragraph, then the loop diagram from "How it works". | "Wallet drains are rarely one transaction. A drainer pulls token after token with an approval you signed; a key sweeper empties one chain, then the next. Between the first loss and the last there are seconds to minutes, and nobody is watching." | README.md |
| 3 | 0:30-0:50 | Page, "What is guarded" panel: HOT, vault, cosigner, the Reactive contract on Lasna, a Guardian per chain. Zoom on "armed". Cut to `Guardian.sol`, the `COLD` immutable and `sweep()` with its two modifiers. | "Three pieces. A reactive contract on Reactive Network subscribes to the wallet's transfers and approvals on all three chains. Each chain has a Guardian the wallet has approved. The Guardian can only ever pay one address, the cold wallet, and only when the call comes through the callback proxy from our own reactive contract." | README Deploy steps 1-5; `src/Guardian.sol` |
| 4 | 0:50-1:05 | Terminal: the cosigner pre-clears 25 tUSD to the shop, then HOT pays it. Page: two rows, "intent stored on Reactive" and "cleared: pre-cleared by an intent". No trip card. | "Normal use first. To pay someone, the second key, here a phone wallet, pre-clears that one payment. The payment goes through and Tripwire stays quiet." (Send the payment only once the page shows "intent stored on Reactive".) | `cast send $INTENT "intendFor(address,address,uint256,uint64)" $TUSD $SHOP 25000000 900 --private-key $COSIGNER_PK`, then `cast send $TUSD "transfer(address,uint256)" $SHOP 25000000 --private-key $HOT_PK` (Base RPC) |
| 5 | 1:05-1:15 | Terminal: `MODE=phish` on Base Sepolia. | "Now the attack. The owner signs a phishing approval for a drainer contract on Base." | `MODE=phish TOKENS=$TETH DRAINER=... forge script script/Drainer.s.sol:DrainerScript --rpc-url $BASE_RPC --broadcast` |
| 6 | 1:15-1:40 | Page, unedited: red "HOT approved drainer for unlimited tETH · TRIPPED" row; the trip card fills: origin (Base), Reactive (Lasna) with its latency, then the three sweeps landing one by one with their latencies. Balance bars turn green. | "The approval itself is the alarm: an unknown spender, nothing pre-cleared. Reactive Network sees the log, the contract trips, and it asks every chain's Guardian to sweep. Base, Unichain, then Ethereum Sepolia with its 12-second blocks. Everything approved is now in the cold wallet, on all three chains." | same take as 5 |
| 7 | 1:40-1:55 | Terminal: `MODE=pull`. Page: no new transfer; hot balances stay at 0. | "When the drainer comes back to pull, there's nothing left to take." | `MODE=pull TOKENS=$TETH ... --rpc-url $BASE_RPC --broadcast` |
| 8 | 1:55-2:15 | Click through from the trip card: origin tx on Basescan, the Reactive tx on Reactscan showing `Tripped` and `SweepRequested`, a callback tx on Uniscan showing `Swept` logs. | "Every step is an ordinary transaction you can check: the approval on Base, the reaction on Lasna, and the sweep callbacks on each chain." | explorer links on the page |
| 9 | 2:15-2:30 | Page latency table, then the README latency table with p50/p95 over the measured runs. | "Origin block to the last sweep took about N seconds here. Over M runs the median was X. We measured it from block timestamps, nothing estimated." | README "Latency" (fill from real runs; don't record this shot before the table has numbers) |
| 10 | 2:30-2:45 | README "Threat model and honest limits", highlight the first bullet; then the repo URL. | "What it doesn't do: the first move still lands, and a one-transaction drain takes what it touches before anything can react. Tripwire saves everything else, on every chain, with no server and no keeper key to run. Code, addresses and transactions are in the repo." | README.md |

Optional if there is time left (replace shot 7): **panic button.** The cosigner presses panic on Ethereum Sepolia,
and the page shows trip "Panic" sweeping all three chains:
`cast send $PANIC "panic()" --rpc-url $ETH_RPC --private-key $COSIGNER_PK`.

## Checks before export

- Every number in shots 6 and 9 is from this recording or from the README tables, not the replay fixture.
- No private key, mnemonic or `key.json` content is visible in any terminal frame.
- The page header says LIVE in every page shot.
- Length under 3:00; captions readable at 720p.
