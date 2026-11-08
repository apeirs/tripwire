#!/usr/bin/env node
// Offline checks for the demo page:  node demo/tools/check.mjs
//  1. every event signature in core.js matches the declaration in src/*.sol (enums count as uint8);
//  2. every topic hash and selector in core.js matches `cast keccak` / `cast sig` (skipped if cast is missing);
//  3. the ABI decoders read what `cast abi-encode` writes;
//  4. demo/fixture.json replays into the expected timeline: one trip from Base, three sweeps, nothing left hot, and a
//     later approval merged into that trip; every verdict links to its origin log by (chain, tx, log index).

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

console.log(`${passed} checks passed${failed ? `, ${failed} FAILED` : ""}`);
process.exit(failed ? 1 : 0);
