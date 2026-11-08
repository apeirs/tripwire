#!/usr/bin/env node
// Offline checks for the demo page:  node demo/tools/check.mjs
//  1. every event signature in core.js matches the declaration in src/*.sol (enums count as uint8);
//  2. every topic hash and selector in core.js matches `cast keccak` / `cast sig` (skipped if cast is missing);
//  3. the ABI decoders read what `cast abi-encode` writes;
//  4. demo/fixture.json replays into the expected timeline: one trip from Base, three sweeps, nothing left hot, and a
//     later approval merged into that trip; every verdict links to its origin log by (chain, tx, log index);
//  5. tools/measure.mjs: percentiles, CSV quoting and the latency table, on that fixture trip;
//  6. the live poller's log ranges stay at or below the RPC's reported head and recover from 'beyond head' races;
//  7. the history load finds past trips (scan and bisect), their origins and sweeps, on a simulated three-chain RPC.

import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, "..");
const repo = join(demo, "..");
const C = createRequire(import.meta.url)(join(demo, "core.js"));

let failed = 0;
let passed = 0;
const ok = (cond, msg) => {
  if (cond) passed++;
  else {
    failed++;
    console.error("FAIL", msg);
  }
};
const eq = (a, b, msg) => ok(a === b, `${msg}: got ${a}, want ${b}`);

// 1. signatures vs Solidity sources ------------------------------------------------------------------------------
const sources = [
  ...readdirSync(join(repo, "src")).filter((f) => f.endsWith(".sol")).map((f) => join(repo, "src", f)),
  join(repo, "src", "mocks", "Drainer.sol"),
  join(repo, "src", "mocks", "MockERC20.sol"),
].map((p) => readFileSync(p, "utf8"));
const declared = {};
const enums = new Set();
for (const src of sources) {
  for (const m of src.matchAll(/enum\s+(\w+)/g)) enums.add(m[1]);
  for (const m of src.matchAll(/event\s+(\w+)\s*\(([^)]*)\)/g)) {
    const types = m[2]
      .split(",")
      .map((p) => p.trim().split(/\s+/)[0])
      .filter(Boolean)
      .map((t) => (enums.has(t) ? "uint8" : t));
    declared[m[1]] = `${m[1]}(${types.join(",")})`;
  }
}
for (const [name, sig] of Object.entries(C.SIGNATURES)) eq(declared[name], sig, `event ${name} in src/`);

// 2. hashes vs cast ----------------------------------------------------------------------------------------------
let cast = true;
try {
  execFileSync("cast", ["--version"], { stdio: "ignore" });
} catch {
  cast = false;
  console.warn("cast not found: skipping hash, selector and ABI checks");
}
const run = (...args) => execFileSync("cast", args, { encoding: "utf8" }).trim();
if (cast) {
  for (const [name, sig] of Object.entries(C.SIGNATURES)) eq(C.TOPIC[name], run("keccak", sig), `topic ${name}`);
  for (const [name, sig] of Object.entries(C.SELECTOR_SIGNATURES)) eq(C.SELECTOR[name], run("sig", sig), `selector ${name}`);

  // 3. decoders
  const cfg = C.decodeChainConfig(
    run(
      "abi-encode",
      "f((address,address,address,address[]))",
      "(0x1111111111111111111111111111111111111111,0x2222222222222222222222222222222222222222,0x0000000000000000000000000000000000000000,[0x3333333333333333333333333333333333333333,0x4444444444444444444444444444444444444444])",
    ),
  );
  eq(cfg.guardian, "0x1111111111111111111111111111111111111111", "chainConfig.guardian");
  eq(cfg.intent, "0x2222222222222222222222222222222222222222", "chainConfig.intent");
  eq(cfg.tokens.join(","), "0x3333333333333333333333333333333333333333,0x4444444444444444444444444444444444444444", "chainConfig.tokens");
  eq(C.decodeUintArray(run("abi-encode", "f(uint256[])", "[84532,11155111,1301]")).join(","), "84532,11155111,1301", "uint256[]");
  eq(C.decodeString(run("abi-encode", "f(string)", "Tripwire Test USD")), "Tripwire Test USD", "string");
  eq(C.decodeString("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0")), "MKR", "bytes32 symbol");
  eq(
    C.encodeCall(C.SELECTOR.allowance, "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"),
    run("calldata", "allowance(address,address)", "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"),
    "encodeCall",
  );
  const lctx = C.makeContext({ lasnaChainId: 5318007 });
  const obs = C.decodeLog(lctx, {
    chainId: 5318007,
    address: "0x0000000000000000000000000000000000000001",
    topics: [C.TOPIC.Observed, C.numTopic(84532), C.TOPIC.Approval, C.addrTopic("0x3333333333333333333333333333333333333333")],
    data: run("abi-encode", "f(uint256,uint8,uint256,uint256)", "5", "4", "0xabc", "7"),
    transactionHash: "0x01",
    logIndex: 0,
    blockNumber: 1,
  });
  eq(obs.verdict, "Merged", "Observed.verdict");
  eq(obs.originTx, "0x" + "abc".padStart(64, "0"), "Observed.originTx");
  eq(obs.originLogIndex, 7, "Observed.originLogIndex");
  const done = C.decodeLog(lctx, {
    chainId: 84532,
    address: "0x0000000000000000000000000000000000000002",
    topics: [C.TOPIC.SweepDone, C.numTopic(1)],
    data: run("abi-encode", "f(uint256,uint256,uint256)", "1", "31", "8"),
    transactionHash: "0x02",
    logIndex: 0,
    blockNumber: 1,
  });
  eq([done.swept, done.skipped, done.unhandled].join(","), "1,31,8", "SweepDone counts");
}
eq(C.formatUnits(975000000n, 6), "975", "formatUnits 6");
eq(C.formatUnits(1234567890000000000000n, 18), "1,234.5678", "formatUnits 18");
eq(C.formatUnits((1n << 256n) - 1n, 18), "unlimited", "formatUnits max");
eq(C.formatUnits(1n, 6), "<0.0001", "formatUnits dust is not shown as 0");
eq(C.formatUnits(0n, 6), "0", "formatUnits zero");
eq(C.formatUnits(20_500_000n, 6), "20.5", "formatUnits 6-decimal USDC");
{
  // Amounts are formatted with each token's own decimals: a real 6-decimal USDC next to an 18-decimal test token.
  const usdc = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
  const teth = "0x1111111111111111111111111111111111111111";
  const dctx = C.makeContext({ chains: { 84532: { tokens: [{ address: usdc, symbol: "USDC", decimals: 6 }, { address: teth, symbol: "tETH", decimals: 18 }] } } });
  eq(C.amountStr(dctx, 84532, usdc, 14_000_000n), "14 USDC", "amountStr USDC (6 decimals)");
  eq(C.amountStr(dctx, 84532, teth, 14n * 10n ** 18n), "14 tETH", "amountStr tETH (18 decimals)");
}

// 4. fixture replay ----------------------------------------------------------------------------------------------
const fx = JSON.parse(readFileSync(join(demo, "fixture.json"), "utf8"));
const ctx = C.makeContext(fx.config);
const logs = [...fx.logs].sort((a, b) => a.blockTimestampMs - b.blockTimestampMs);
const known = new Set(Object.values(C.TOPIC));
ok(logs.every((l) => known.has(l.topics[0].toLowerCase())), "every fixture log has a known topic0");

// part way: the trip has fired on Reactive but no callback has landed
const tripLog = logs.find((l) => l.topics[0] === C.TOPIC.Tripped);
const m1 = new C.Monitor(ctx);
m1.ingest(logs.filter((l) => l.blockTimestampMs <= tripLog.blockTimestampMs));
const v1 = m1.view();
eq(v1.trips.length, 1, "mid-replay trips");
eq(v1.trips[0].status, "sweeping", "mid-replay status");

const m = new C.Monitor(ctx);
eq(m.ingest(logs), logs.length, "all fixture logs decode");
eq(m.ingest(logs), 0, "re-ingest is deduped");
const v = m.view();
eq(v.trips.length, 1, "trips");
const t = v.trips[0];
eq(t.reason, "Approval", "trip reason");
eq(t.originRef.chainId, 84532, "origin chain");
ok(!!t.origin && t.origin.name === "Approval", "origin log linked by (chain, tx, logIndex)");
eq(t.origin.spender, Object.keys(ctx.labels).find((a) => ctx.labels[a] === "drainer"), "origin spender is the drainer");
eq(t.requests.length, 3, "sweep requests");
eq(Object.keys(t.sweeps).length, 3, "sweeps landed");
for (const s of Object.values(t.sweeps)) {
  eq(s.swept.length, 3, `tokens swept on ${s.chainId}`);
  ok(s.done && s.done.swept === 3 && s.done.skipped === 0 && s.done.unhandled === 0, `SweepDone on ${s.chainId}`);
}
eq(t.merged.length, 1, "later approval merged into trip #1");
eq(t.merged[0].reason, "Approval", "merged reason");
ok(!!t.merged[0].origin && t.merged[0].origin.name === "Approval" && t.merged[0].origin.txHash !== t.originRef.txHash, "merged move linked to its own origin tx");
eq(v.events.filter((e) => e.name === "SweepRequested").length, 3, "the merged approval requested no sweep");

const fixtureLog = new Set(fx.logs.map((l) => `${l.chainId}:${l.transactionHash.toLowerCase()}:${l.logIndex}`));
const observed = v.events.filter((e) => e.name === "Observed");
ok(observed.length > 0 && observed.every((e) => fixtureLog.has(`${e.originChainId}:${e.originTx}:${e.originLogIndex}`)), "every Observed names a fixture origin log");
eq(t.status, "swept", "trip status");
ok(t.latency.toReactive > 0 && t.latency.allSwept > t.latency.toReactive, "latencies ordered");
eq(t.latency.sweeps[84532].approx, false, "Base origin to Base sweep uses millisecond timestamps");
for (const [id, l] of Object.entries(t.latency.sweeps)) ok(l.fromOrigin > 0 && l.fromReactive > 0, `latency ${id}`);

const verdicts = v.feed.filter((r) => r.verdict).map((r) => r.verdict);
ok(verdicts.includes("cleared: pre-cleared by an intent"), "payment cleared by intent");
ok(verdicts.includes("intent stored on Reactive"), "intent stored");
ok(verdicts.includes("TRIPPED"), "approval tripped");
ok(verdicts.includes("merged into trip #1: no new sweep"), "second approval shown as merged");
ok(!v.feed.some((r) => /sent from HOT to VAULT/.test(r.text)), "sweep transfers are folded into the sweep rows");
eq(v.feed.filter((r) => r.kind === "sweep").length, 3, "three sweep rows");

const bal = C.foldBalances(ctx, fx.initialBalances, m.events);
let hotLeft = 0n;
for (const toks of Object.values(bal)) for (const b of Object.values(toks)) hotLeft += b.hot;
eq(hotLeft, 0n, "nothing left in the hot wallet");
const baseUsd = fx.config.chains["84532"].tokens.find((x) => x.symbol === "tUSD").address.toLowerCase();
eq(bal["84532"][baseUsd].cold, 975_000_000n, "Base tUSD in vault (1000 minus the 25 paid)");

// 5. tools/measure.mjs: statistics, CSV and the table, on the fixture ----------------------------------------------
const M = await import(join(repo, "tools", "measure.mjs"));
eq(M.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5), 5.5, "median (even count)");
ok(Math.abs(M.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) - 9.1) < 1e-9, "p90 interpolates");
eq(M.percentile([7], 0.9), 7, "p90 of one run");
eq(M.toRaw("1.5", 6), 1_500_000n, "toRaw 6 decimals");
eq(M.toRaw("2", 18), 2n * 10n ** 18n, "toRaw 18 decimals");
eq(JSON.stringify(M.parseCsv('a,"b,c",d\n1,"say ""hi""",3\n')), JSON.stringify([["a", "b,c", "d"], ["1", 'say "hi"', "3"]]), "CSV quoting");
{
  const rows = t.requests.length ? M.rowsFromTrip(t, { runId: "r1", utc: "2026-11-08T00:00:00Z", source: "fixture" }) : [];
  eq(rows.length, 3, "one CSV row per destination chain");
  ok(rows.every((r) => r.status === "ok" && r.sweep_tx && r.sweep_block !== "" && r.reactive_tx), "rows carry tx hashes and blocks");
  const S = M.summarize(rows);
  eq(S.ok.length, 1, "summarize: one complete run");
  const e2e = S.groups.get(84532).get("e2e").samples[0];
  eq(e2e, t.latency.allSwept, "end to end equals the page's 'all swept' latency");
  const failedRun = rows.map((r, i) => ({ ...r, run_id: "r2", status: i === 2 ? "timeout" : "ok" }));
  const S2 = M.summarize([...rows, ...failedRun]);
  eq(S2.failed.length, 1, "a run with one missing sweep is left out");
  const { text } = M.renderTable(rows, { 84532: { name: "Base Sepolia" }, 11155111: { name: "Ethereum Sepolia" }, 1301: { name: "Unichain Sepolia" } }, { simulated: true });
  ok(/\*\*Simulated, not measured\.\*\*/.test(text), "fixture table is labelled simulated");
  ok(text.includes("| Base Sepolia | **origin block → last sweep block (end to end)** | 1 | ≈6.00 s |"), "end-to-end row");
}

{
  // One deployer with the same nonces on two chains gets the same Guardian address on both (the mainnet throwaway
  // does): each chain's sweep must stay on its own chain, and a Guardian address from another deployment is ignored.
  const g = "0x2279b7a0a67db372996a5fab50d91eaa73d2ebe6";
  const sctx = C.makeContext({ lasnaChainId: 1597, chains: { 8453: { guardian: g }, 130: { guardian: g } } });
  const sm = new C.Monitor(sctx);
  const sweepLog = (chainId, address, tx) => ({
    chainId, address, topics: [C.TOPIC.SweepDone, C.numTopic(1)], data: run("abi-encode", "f(uint256,uint256,uint256)", "3", "0", "0"),
    transactionHash: tx, logIndex: 0, blockNumber: 5, blockTimestampMs: 1000, tsExact: true,
  });
  sm.ingest([sweepLog(8453, g, "0x0a"), sweepLog(130, g, "0x0b"), sweepLog(8453, "0x00000000000000000000000000000000000000ff", "0x0c")]);
  const st = sm.view().trips.find((x) => x.tripId === 1);
  eq(Object.keys((st || {}).sweeps || {}).sort().join(","), "130,8453", "same Guardian address on two chains: one sweep per chain");
  eq(st && st.sweeps[8453].txHash, "0x0a", "a foreign Guardian's SweepDone is ignored");
}

// 6. live poller: ranges clamped to the RPC's own head, 'beyond head' races retried --------------------------------
{
  const he = C.headError("eth_getLogs: block range extends beyond current head block");
  ok(he && he.head === null, "headError: op-geth/proxyd message without a head");
  eq(C.headError("eth_getLogs: block range extends beyond current head block: requested 54709729, head 54709728").head, 54709728, "headError: publicnode names the head");
  eq(C.headError("block not available: block not found for eth_getLogs, requested toBlock 8554848 is not yet available on the node (latestBlock: 8554416, finalizedBlock: 8554415)").head, 8554416, "headError: Reactive names latestBlock");
  eq(C.headError("eth_getLogs: timeout"), null, "headError: a timeout is not a head race");
  eq(C.headError("429 Too Many Requests"), null, "headError: rate limit is not a head race");
  eq(JSON.stringify(C.nextRange(100, 200, { maxRange: 50 })), JSON.stringify({ from: 101, to: 150 }), "nextRange caps at maxRange");
  eq(JSON.stringify(C.nextRange(180, 200, { maxRange: 50, lag: 3 })), JSON.stringify({ from: 181, to: 197 }), "nextRange clamps to head minus lag");
  eq(C.nextRange(197, 200, { lag: 3 }), null, "nextRange: nothing new below the clamped head");
  eq(C.nextRange(210, 200, {}), null, "nextRange: a head behind the cursor reads nothing");
  eq(C.learnHeadLag(0, 1000, { head: 997 }), 3, "learnHeadLag: as far back as the node said");
  eq(C.learnHeadLag(5, 1000, { head: 999 }), 6, "learnHeadLag: at least one more than before");
  eq(C.learnHeadLag(0, 1000, { head: null }), 1, "learnHeadLag: unknown head starts at 1");
  eq(C.learnHeadLag(4, 1000, { head: null }), 8, "learnHeadLag: unknown head doubles");
  eq(C.learnHeadLag(60, 1000, { head: null }), C.MAX_HEAD_LAG, "learnHeadLag is capped");

  // A load balancer whose eth_getLogs node is always 2 blocks behind the eth_blockNumber node (the Unichain RPC seen
  // from the hosted page): the poller's loop from app.js, on core's helpers. One refused range, then no errors, and
  // the cursor keeps up with the logs node's head.
  for (const named of [false, true]) {
    let head = 5000;
    let errors = 0;
    let lag = 0;
    let cursor = head - 600;
    const getLogs = (from, to) => {
      if (to > head - 2) throw new Error(`eth_getLogs: block range extends beyond current head block${named ? `: requested ${to}, head ${head - 2}` : ""}`);
      return [];
    };
    for (let poll = 0; poll < 20; poll++) {
      head += 4;
      const latest = head;
      let r;
      while ((r = C.nextRange(cursor, latest, { maxRange: 1000, lag }))) {
        try {
          getLogs(r.from, r.to);
        } catch (e) {
          errors++;
          lag = C.learnHeadLag(lag, latest, C.headError(e.message));
          break;
        }
        cursor = r.to;
      }
    }
    ok(errors <= 2, `lagging logs node${named ? " (head named)" : ""}: ${errors} refused range(s), then none`);
    eq(cursor, head - 2, `lagging logs node${named ? " (head named)" : ""}: cursor at the logs node's head`);
  }
}

// 7. history on load: past trips from TripwireReactive's logs, sweeps found by time on each chain -------------------
{
  const pad = (v) => (typeof v === "string" ? v.replace(/^0x/, "").toLowerCase().padStart(64, "0") : BigInt(v).toString(16).padStart(64, "0"));
  const data = (...w) => "0x" + w.map(pad).join("");
  const hex = (n) => "0x" + n.toString(16);
  const NOW = 1_800_000_000_000;
  const L = 1597;
  const chainsDef = {
    [L]: { head: 20000, ms: 1000, exactTs: false },
    8453: { head: 1_000_000, ms: 200, exactTs: true },
    130: { head: 500_000, ms: 1000, exactTs: false },
  };
  const tsOf = (id, b) => NOW - (chainsDef[id].head - b) * chainsDef[id].ms;
  const blockOf = (id, ms) => chainsDef[id].head - Math.round((NOW - ms) / chainsDef[id].ms);
  const A = (n) => "0x" + n.toString(16).padStart(40, "0");
  const TRIPWIRE = A(0x7e1), HOT = A(0x401), COLD = A(0xc01), ATT = A(0xa77), G_BASE = A(0x6b), G_UNI = A(0x6c), TOK = A(0x70c);
  const DEPLOY = 5000;
  const logs = { [L]: [], 8453: [], 130: [] };
  const receipts = {};
  const tripBlocks = [];
  let txn = 0;
  const tx = () => "0x" + (++txn).toString(16).padStart(64, "0");
  for (let i = 1; i <= 8; i++) {
    const rb = 6000 + 1500 * (i - 1);
    tripBlocks.push(rb);
    const oc = i % 2 ? 130 : 8453;
    const ob = blockOf(oc, tsOf(L, rb) - 1000);
    const otx = tx();
    const o = { address: TOK, topics: [C.TOPIC.Transfer, C.addrTopic(HOT), C.addrTopic(ATT)], data: data(5_000_000), transactionHash: otx, logIndex: "0x0", blockNumber: hex(ob) };
    logs[oc].push(o);
    receipts[otx] = { blockNumber: hex(ob), logs: [o] };
    const rtx = tx();
    const rl = (topics, d, li) => ({ address: TRIPWIRE, topics, data: d, transactionHash: rtx, logIndex: hex(li), blockNumber: hex(rb) });
    logs[L].push(
      rl([C.TOPIC.Observed, C.numTopic(oc), C.TOPIC.Transfer, C.addrTopic(ATT)], data(5_000_000, 3, otx, 0), 0),
      rl([C.TOPIC.Tripped, C.numTopic(i), C.numTopic(0), C.numTopic(oc)], data(otx, 0), 1),
      rl([C.TOPIC.SweepRequested, C.numTopic(i), C.numTopic(8453)], data(G_BASE, 1), 2),
      rl([C.TOPIC.SweepRequested, C.numTopic(i), C.numTopic(130)], data(G_UNI, 1), 3),
    );
    for (const [id, g, after] of [[8453, G_BASE, 1600], [130, G_UNI, 2000]]) {
      if (i === 8 && id === 130) continue; // this callback never landed: the page must say so, not wait forever
      const sb = blockOf(id, tsOf(L, rb) + after);
      const stx = tx();
      logs[id].push(
        { address: g, topics: [C.TOPIC.Swept, C.numTopic(i), C.addrTopic(TOK)], data: data(5_000_000), transactionHash: stx, logIndex: "0x0", blockNumber: hex(sb) },
        { address: g, topics: [C.TOPIC.SweepDone, C.numTopic(i)], data: data(1, 0, 0), transactionHash: stx, logIndex: "0x1", blockNumber: hex(sb) },
      );
    }
  }
  const stats = { getLogs: 0, beyondHead: 0, overRange: 0 };
  const topicOk = (want, have) => want == null || (Array.isArray(want) ? want.map((x) => x.toLowerCase()).includes(have) : want.toLowerCase() === have);
  async function fakeRpc(id, method, params) {
    const def = chainsDef[id];
    if (!def) throw new Error("no chain " + id);
    switch (method) {
      case "eth_blockNumber":
        return hex(def.head);
      case "eth_getBlockByNumber": {
        const n = params[0] === "latest" ? def.head : parseInt(params[0], 16);
        if (n > def.head) return null;
        const ms = tsOf(id, n);
        return { number: hex(n), timestamp: hex(Math.floor(ms / 1000)), ...(def.exactTs ? { timestampMs: hex(ms) } : {}) };
      }
      case "eth_call": {
        const b = parseInt(params[1], 16);
        if (params[0].data !== C.SELECTOR.trips) throw new Error("unexpected call");
        return b < DEPLOY ? "0x" : data(tripBlocks.filter((x) => x <= b).length);
      }
      case "eth_getLogs": {
        stats.getLogs++;
        const f = params[0];
        const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
        if (to > def.head) {
          stats.beyondHead++;
          throw new Error("block range extends beyond current head block");
        }
        if (to - from + 1 > 1000) {
          stats.overRange++;
          throw new Error("block range too large");
        }
        const addrs = [f.address].flat().map((a) => a.toLowerCase());
        return logs[id].filter((l) => {
          const b = parseInt(l.blockNumber, 16);
          return b >= from && b <= to && addrs.includes(l.address) && (f.topics || []).every((want, k) => topicOk(want, l.topics[k]));
        });
      }
      case "eth_getTransactionReceipt":
        return receipts[params[0]] || null;
      default:
        throw new Error("unexpected " + method);
    }
  }
  const hctx = C.makeContext({
    lasnaChainId: L,
    tripwire: TRIPWIRE,
    hot: HOT,
    cold: COLD,
    cosigner: HOT,
    chains: { 8453: { guardian: G_BASE, tokens: [{ address: TOK, symbol: "TDT", decimals: 6 }] }, 130: { guardian: G_UNI, tokens: [{ address: TOK, symbol: "TDT", decimals: 6 }] } },
  });
  const hnets = { [L]: { maxRange: 1000, blockMs: 786 }, 8453: { maxRange: 1000, blockMs: 200 }, 130: { maxRange: 1000, blockMs: 1000 } };

  // Scan mode: 15 chunks since the deploy block.
  const hm = new C.Monitor(hctx);
  let onTripsAt = null;
  const h = await C.loadHistory({ rpc: fakeRpc, ctx: hctx, monitor: hm, nets: hnets, fromBlock: DEPLOY, recent: 5, retryMs: 1, onTrips: (x) => (onTripsAt = x.compact.slice()) });
  eq(h.mode, "scan", "history: scans the reactive contract's logs since fromBlock when that's cheap");
  eq(h.total, 8, "history: trips() count");
  eq(h.detailed.join(","), "8,7,6,5,4", "history: the 5 newest trips get sweeps");
  eq(h.compact.join(","), "3,2,1", "history: older trips listed without sweeps");
  eq((onTripsAt || []).join(","), "3,2,1", "history: onTrips reports the compact set before sweeps load");
  const hv = hm.view();
  eq(hv.trips.length, 8, "history: every past trip is in the monitor");
  for (const id of [4, 5, 6, 7]) {
    const t = hv.trips.find((x) => x.tripId === id);
    ok(t && t.status === "swept" && Object.keys(t.sweeps).sort().join(",") === "130,8453", `history: trip #${id} swept on Base and Unichain`);
    ok(t && t.origin && t.origin.name === "Transfer", `history: trip #${id} origin receipt linked`);
    ok(t && t.latency.allSwept >= 2000 && t.latency.allSwept <= 4000, `history: trip #${id} end-to-end latency from block times (${t && t.latency.allSwept} ms)`);
    ok(t && t.latency.sweeps[8453].fromOrigin > 0 && t.latency.toReactive != null, `history: trip #${id} per-step latencies`);
  }
  const t8 = hv.trips.find((x) => x.tripId === 8);
  ok(t8.sweeps[8453] && !t8.sweeps[130] && t8.status === "sweeping", "history: trip #8 has its Base sweep, not its Unichain one");
  eq([...h.missing].join(","), "8:130", "history: only the callback that never landed is reported missing");
  ok(!hv.trips.find((x) => x.tripId === 1).origin, "history: no receipts fetched for compact trips");
  eq(stats.beyondHead + stats.overRange, 0, "history: no range past a head or over maxRange");
  ok(h.calls <= 120, `history (scan): bounded RPC calls (${h.calls})`);

  // Bisect mode: too many chunks to scan, so the newest trips are found by bisecting trips() over historical state.
  for (const fromBlock of [DEPLOY, null]) {
    const bm = new C.Monitor(hctx);
    const b = await C.loadHistory({ rpc: fakeRpc, ctx: hctx, monitor: bm, nets: hnets, fromBlock, recent: 5, scanChunks: 3, retryMs: 1 });
    const bv = bm.view();
    const label = `history (bisect, fromBlock ${fromBlock})`;
    eq(b.mode, "bisect", `${label}: mode`);
    eq(bv.trips.map((x) => x.tripId).join(","), "4,5,6,7,8", `${label}: exactly the 5 newest trips`);
    ok(bv.trips.filter((x) => x.status === "swept").length === 4, `${label}: their sweeps found`);
    ok(b.calls <= 250, `${label}: bounded RPC calls (${b.calls})`);
  }
  eq(stats.beyondHead + stats.overRange, 0, "history (bisect): no range past a head or over maxRange");

  // A dead RPC: history fails quietly (the page keeps polling live), it never throws past loadHistory's caller.
  const dm = new C.Monitor(hctx);
  let threw = null;
  await C.loadHistory({ rpc: async () => { throw new Error("fetch failed"); }, ctx: hctx, monitor: dm, nets: hnets, fromBlock: DEPLOY, retryMs: 1 }).catch((e) => (threw = e));
  ok(threw && /fetch failed/.test(threw.message), "history: an unreachable Reactive RPC rejects once (the page shows a note)");

  // The mainnet config names the deploy block, so the hosted page scans instead of bisecting.
  const mcfg = JSON.parse(readFileSync(join(demo, "config.mainnet.json"), "utf8"));
  ok(Number.isInteger(mcfg.fromBlock) && mcfg.fromBlock > 0, "config.mainnet.json has the deploy block as fromBlock");
}

console.log(`${passed} checks passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
