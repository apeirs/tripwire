#!/usr/bin/env node
// Turns the raw log trace printed by test/DemoTrace.t.sol into demo/fixture.json for the page's mock mode.
//
//   forge test --mt test_demoTrace -vv --json | node demo/tools/build-fixture.mjs > demo/fixture.json
//
// Every log (address, topics, data) and every transaction hash the contracts saw comes from the trace, so the
// replay exercises the real event encodings. What the trace can't have is time: block numbers and timestamps are
// added here from the timing model below. Those numbers are illustrative, not measured, and the fixture says so.

import { readFileSync } from "node:fs";

const LASNA = 5318007;

// Block time and a starting block per chain (block times measured 2026-11-08 over the last 1,000 blocks).
const CHAINS = {
  84532: { blockMs: 200, block0: 55_870_000 }, // Base Sepolia (timestampMs on blocks)
  11155111: { blockMs: 12_000, block0: 12_087_000 }, // Ethereum Sepolia
  1301: { blockMs: 1_000, block0: 67_240_000 }, // Unichain Sepolia
  [LASNA]: { blockMs: 1_065, block0: 7_797_000 }, // Lasna
};
const T0 = Date.UTC(2026, 10, 8, 12, 0, 0); // synthetic start, 2026-11-08 12:00:00Z

// Timing model (ms). Origin txs at fixed offsets; each hop lands in the first block after its delay.
const ORIGIN_AT = { intend: 0, payment: 18_000, phish: 42_000, phish2: 102_000 };
const REACT_DELAY = 1_200; // origin block -> Lasna block with react()
const CALLBACK_DELAY = { 84532: 1_400, 1301: 1_900, 11155111: 2_500 }; // Lasna block -> destination inclusion
const ECHO_GAP = 350; // spacing between successive react() txs for one batch of logs

function readInput() {
  const raw = readFileSync(0, "utf8");
  try {
    const json = JSON.parse(raw);
    const lines = [];
    for (const suite of Object.values(json)) {
      for (const result of Object.values(suite.test_results ?? {})) lines.push(...(result.decoded_logs ?? []));
    }
    return lines;
  } catch {
    return raw.split("\n").map((l) => l.trim());
  }
}

/** First block on `chainId` whose timestamp is at or after `ms`. */
function blockAt(chainId, ms) {
  const c = CHAINS[chainId];
  const n = Math.ceil((ms - T0) / c.blockMs);
  return { blockNumber: c.block0 + n, ts: T0 + n * c.blockMs };
}

function main() {
  const lines = readInput().filter((l) => /^(META|CHAIN|TOKEN|TX|LOG|END)\b/.test(l));
  if (!lines.includes("END")) throw new Error("trace incomplete: no END line (did the test pass?)");

  const config = { lasnaChainId: LASNA, chains: {}, labels: {} };
  const initialBalances = {};
  const txs = [];
  for (const line of lines) {
    const f = line.split("|");
    if (f[0] === "META") {
      if (["hot", "cold", "cosigner", "tripwire"].includes(f[1])) config[f[1]] = f[2];
      else config.labels[f[2]] = f[1];
    } else if (f[0] === "CHAIN") {
      (config.chains[f[1]] ??= { tokens: [] })[f[2]] = f[3];
    } else if (f[0] === "TOKEN") {
      const [, chainId, address, symbol, decimals, hotBalance] = f;
      config.chains[chainId].tokens.push({ address, symbol, decimals: Number(decimals) });
      (initialBalances[chainId] ??= {})[address] = { hot: hotBalance, cold: "0" };
    } else if (f[0] === "TX") {
      txs.push({ kind: f[1], step: f[2], chainId: Number(f[3]), hash: f[4], logs: [] });
    } else if (f[0] === "LOG") {
      const [, logIndex, address, topics, data] = f;
      txs.at(-1).logs.push({ logIndex: Number(logIndex), address, topics: topics.split(","), data });
    }
  }

  // Assign times. A react tx follows the tx that produced its input; callbacks follow the trip's react tx.
  let lastSource = null; // { ts } of the origin/callback tx whose logs the next react txs handle
  let reactCursor = 0;
  let tripReactTs = null;
  for (const tx of txs) {
    let at;
    if (tx.kind === "origin") {
      at = blockAt(tx.chainId, T0 + ORIGIN_AT[tx.step]);
      lastSource = at;
      reactCursor = 0;
    } else if (tx.kind === "callback") {
      at = blockAt(tx.chainId, tripReactTs + CALLBACK_DELAY[tx.chainId]);
      lastSource = at;
      reactCursor = 0;
    } else {
      at = blockAt(LASNA, lastSource.ts + REACT_DELAY + reactCursor++ * ECHO_GAP);
      if (tx.step === "phish") tripReactTs = at.ts;
    }
    tx.blockNumber = at.blockNumber;
    tx.ts = at.ts;
  }

  const logs = txs
    .flatMap((tx) =>
      tx.logs.map((l) => ({
        chainId: tx.chainId,
        blockNumber: tx.blockNumber,
        blockTimestampMs: tx.ts,
        tsExact: tx.chainId === 84532, // live: only Base Sepolia blocks carry timestampMs
        transactionHash: tx.hash,
        ...l,
      })),
    )
    .sort((a, b) => a.blockTimestampMs - b.blockTimestampMs || a.chainId - b.chainId || a.logIndex - b.logIndex);

  const fixture = {
    format: "tripwire-demo-fixture/1",
    note:
      "Simulated replay. Logs were emitted by the real Tripwire contracts in Foundry's in-process Omni loop " +
      "(test/DemoTrace.t.sol): addresses, topics and data are real encodings. Transaction hashes, block numbers " +
      "and timestamps are synthetic (demo/tools/build-fixture.mjs timing model), so the latencies shown are " +
      "illustrative, not measured.",
    scenario: [
      "Base Sepolia: the cosigner pre-clears 25 tUSD to a shop, then the hot wallet pays it. No trip.",
      "Base Sepolia: the hot wallet signs an unlimited tETH approval for a drainer contract. Trip #1.",
      "Every chain's Guardian sweeps the approved tokens to COLD; the sweeps' own transfers clear.",
      "The drainer pulls tETH and gets nothing: the hot wallet is already empty.",
      "A minute later, a second phishing approval (tDAI) in its own transaction: merged into trip #1, no new sweep.",
    ],
    config,
    initialBalances,
    logs,
  };
  process.stdout.write(JSON.stringify(fixture, null, 2) + "\n");
}

main();
