#!/usr/bin/env node
// Latency runs on the live deployment:  node tools/measure.mjs --runs 10
//
// For each run: tops HOT up on the open-mint demo tokens (and, with --refill, moves faucet USDC back from COLD),
// sends one untrusted move from HOT on the origin chain (script/Measure.s.sol, keys from the environment like every
// other script), then polls the origin chain, Reactive Network and every destination chain for the trip:
// Observed/Tripped on Reactive Network (Lasna or mainnet), SweepDone from each Guardian. It records block timestamps
// (Base in ms, the others in whole seconds)
// and wall-clock times, appends one CSV row per (run, destination chain), and writes a median/p90 table into
// README.md between the `measure:latency` markers.
//
// The merge window (tripCooldown) is set to 0 for the session so runs don't merge into each other, and set back to
// its previous value afterwards, on errors, timeouts and Ctrl-C too.
//
// Latencies come from demo/core.js's Monitor, the same model the demo page renders, so the README and the page agree.
// No dependencies: node >= 18 (fetch), forge and cast on PATH.
//
//   node tools/measure.mjs --dry-run                 # the plan, nothing sent
//   node tools/measure.mjs --fixture                 # table from demo/fixture.json (simulated), prints only
//   node tools/measure.mjs --runs 10 --origin all    # live: needs PRIVATE_KEY (owner) and HOT_PK in the env
//   node tools/measure.mjs --mainnet --dry-run       # Reactive mainnet + Base/Unichain (demo/config.mainnet.json)

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const C = createRequire(import.meta.url)(join(repo, "demo", "core.js"));

const LASNA = 5318007;
const REACTIVE_MAINNET = 1597;
// Per network; the config's lasnaChainId (the Reactive chain id) says which: 1597 = mainnet, anything else = testnet.
const ENV_RPC = {
  testnet: { 5318007: "LASNA_RPC", 84532: "BASE_RPC", 11155111: "ETH_RPC", 1301: "UNI_RPC" },
  mainnet: { 1597: "REACTIVE_RPC", 8453: "BASE_RPC", 1: "ETH_RPC", 130: "UNI_RPC" },
};
const CHAIN_ALIAS = {
  testnet: { base: 84532, eth: 11155111, ethereum: 11155111, uni: 1301, unichain: 1301, lasna: LASNA, reactive: LASNA },
  mainnet: { base: 8453, eth: 1, ethereum: 1, uni: 130, unichain: 130, reactive: REACTIVE_MAINNET },
};
const CHAIN_ORDER = [84532, 8453, 11155111, 1, 1301, 130]; // Base, Ethereum, Unichain (testnet, mainnet)
const netOf = (reactiveId) => (reactiveId === REACTIVE_MAINNET ? "mainnet" : "testnet");
const chainAlias = (name, reactiveId) => CHAIN_ALIAS[netOf(reactiveId)][String(name).toLowerCase()] ?? Number(name);
const SECRET_ENV = ["PRIVATE_KEY", "HOT_PK", "COSIGNER_PK", "COLD_PK", "ATTACKER_PK"];
const DEFAULT_SINK = "0x000000000000000000000000000000000000dEaD";
const MARK_BEGIN = "<!-- measure:latency:begin";
const MARK_END = "<!-- measure:latency:end -->";
const CSV_COLUMNS = [
  "run_id", "utc", "source", "scenario", "origin_chain", "origin_tx", "origin_log_index", "origin_block", "origin_ms",
  "origin_exact", "verdict", "trip_id", "reactive_tx", "reactive_block", "reactive_ms", "reactive_exact", "dest_chain",
  "sweep_tx", "sweep_block", "sweep_ms", "sweep_exact", "swept", "skipped", "unhandled", "wall_trigger_ms",
  "wall_origin_seen_ms", "wall_reactive_seen_ms", "wall_sweep_seen_ms", "status", "note",
];

const HELP = `node tools/measure.mjs [options]

Modes
  (default)            live runs on the deployment named by --tripwire / demo/config.json
  --dry-run            print the plan (reads chain state if reachable, sends nothing)
  --fixture            compute the table from demo/fixture.json (simulated) and print it; writes files only if
                       --csv / --readme are given explicitly

Run options
  --runs N             runs (default 10)
  --origin X           origin chain: a chain id | base | eth | uni | all (rotate), default: first chain
  --scenario S         transfer (default) | approval | panic (cosigner, needs COSIGNER_PK)
  --token T            token to move: address or symbol on the origin chain (default: first open-mint token)
  --amount A           amount in whole tokens, decimals read from the token (default 1)
  --to ADDR            untrusted recipient / spender (default $ATTACKER, else 0x…dEaD)
  --mint N             top HOT up to N whole tokens of every open-mint token on every chain before each run
                       (default 1000; 0 = off). Needs PRIVATE_KEY.
  --refill             before each run, COLD sends its balance of non-mintable tokens (faucet USDC) back to HOT.
                       Needs COLD_PK and gas for COLD.
  --timeout S          per-run limit from trigger to the last sweep, seconds (default 600)
  --gap S              pause between runs, seconds (default 5)
  --poll MS            poll interval (default 1000)
  --rpc-timeout MS     per-request RPC timeout (default 15000); 3 retries with backoff
  --keep-cooldown      don't touch tripCooldown (runs inside one window merge: only useful for a single run)

Inputs and outputs
  --mainnet            Reactive mainnet (1597) + Base / Ethereum / Unichain: default config demo/config.mainnet.json
  --config PATH        demo config (networks + tripwire); default demo/config.json (Lasna + Sepolias). With a default
                       config, LASNA_RPC (or REACTIVE_RPC on mainnet) / BASE_RPC / ETH_RPC / UNI_RPC override its RPCs;
                       an explicit --config wins over them.
  --rpc ID=URL         override one chain's RPC (repeatable)
  --tripwire ADDR      TripwireReactive on Reactive Network (else $TRIPWIRE, else config "tripwire")
  --csv PATH           per-run CSV, appended (default docs/latency.csv); --fresh starts it over
  --readme PATH        file with the measure:latency markers (default README.md); --no-readme to skip
  --source LABEL       CSV "source" column (default: live, fixture in --fixture mode)

Keys (environment only, never printed): PRIVATE_KEY (TripwireReactive owner; mints), HOT_PK, COSIGNER_PK, COLD_PK.
Exit: 0 all runs ok, 2 some runs failed or timed out, 1 setup error.`;

// ------------------------------------------------------------------ args

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", short: "h" },
      "dry-run": { type: "boolean" },
      fixture: { type: "boolean" },
      "fixture-file": { type: "string" },
      runs: { type: "string" },
      origin: { type: "string" },
      scenario: { type: "string" },
      token: { type: "string" },
      amount: { type: "string" },
      to: { type: "string" },
      mint: { type: "string" },
      refill: { type: "boolean" },
      timeout: { type: "string" },
      gap: { type: "string" },
      poll: { type: "string" },
      "rpc-timeout": { type: "string" },
      "keep-cooldown": { type: "boolean" },
      config: { type: "string" },
      mainnet: { type: "boolean" },
      rpc: { type: "string", multiple: true },
      tripwire: { type: "string" },
      csv: { type: "string" },
      readme: { type: "string" },
      "no-readme": { type: "boolean" },
      fresh: { type: "boolean" },
      source: { type: "string" },
    },
    strict: true,
  });
  const num = (k, d, min = 0) => {
    if (values[k] == null) return d;
    const n = Number(values[k]);
    if (!Number.isFinite(n) || n < min) throw new Error(`--${k} must be a number >= ${min}`);
    return n;
  };
  const o = {
    help: !!values.help,
    dryRun: !!values["dry-run"],
    fixture: !!values.fixture,
    fixtureFile: resolve(values["fixture-file"] || join(repo, "demo", "fixture.json")),
    runs: num("runs", 10, 1),
    origin: values.origin || null,
    scenario: values.scenario || "transfer",
    token: values.token || null,
    amount: values.amount || "1",
    to: values.to || process.env.ATTACKER || DEFAULT_SINK,
    mint: values.mint ?? "1000",
    refill: !!values.refill,
    timeoutMs: num("timeout", 600, 1) * 1000,
    gapMs: num("gap", 5) * 1000,
    pollMs: num("poll", 1000, 100),
    rpcTimeoutMs: num("rpc-timeout", 15000, 1000),
    keepCooldown: !!values["keep-cooldown"],
    mainnet: !!values.mainnet,
    configPath: values.config ? resolve(values.config) : join(repo, "demo", values.mainnet ? "config.mainnet.json" : "config.json"),
    configExplicit: !!values.config,
    rpcOverrides: values.rpc || [],
    tripwire: values.tripwire || process.env.TRIPWIRE || null,
    csvPath: values.csv ? resolve(values.csv) : null,
    readmePath: values["no-readme"] ? null : values.readme ? resolve(values.readme) : null,
    csvExplicit: values.csv != null,
    readmeExplicit: values.readme != null,
    noReadme: !!values["no-readme"],
    fresh: !!values.fresh,
    source: values.source || null,
  };
  if (!["transfer", "approval", "panic"].includes(o.scenario)) throw new Error("--scenario must be transfer, approval or panic");
  if (!/^\d+(\.\d+)?$/.test(o.amount)) throw new Error("--amount must be a plain decimal number of whole tokens");
  if (!/^\d+(\.\d+)?$/.test(String(o.mint))) throw new Error("--mint must be a number of whole tokens");
  if (!/^0x[0-9a-fA-F]{40}$/.test(o.to)) throw new Error("--to must be an address");
  if (o.tripwire && !/^0x[0-9a-fA-F]{40}$/.test(o.tripwire)) throw new Error("--tripwire must be an address");
  if (!o.fixture) {
    o.csvPath ??= join(repo, "docs", "latency.csv");
    if (!o.noReadme) o.readmePath ??= join(repo, "README.md");
  }
  return o;
}

// ------------------------------------------------------------------ small helpers

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("warning:", ...a);
const isoNow = () => new Date().toISOString();
/** A path for messages: relative when under the working directory, absolute otherwise. */
const shown = (p) => {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith("..") ? r : p;
};
const lc = (a) => (a ? String(a).toLowerCase() : "");
const ZERO = /^0x0{40}$/i;

/** Removes the values of key env vars from text before it is printed (forge errors can echo arguments). */
function redact(text) {
  let out = String(text ?? "");
  for (const k of SECRET_ENV) {
    const v = process.env[k];
    if (v && v.length >= 16) out = out.split(v).join(`<${k}>`);
    if (v && v.length >= 16 && v.startsWith("0x")) out = out.split(v.slice(2)).join(`<${k}>`);
  }
  return out;
}

class Aborted extends Error {}
const state = { abort: false, sigints: 0 };

function sleep(ms) {
  return new Promise((res, rej) => {
    if (state.abort) return rej(new Aborted("interrupted"));
    const t = setTimeout(() => {
      clearInterval(iv);
      res();
    }, ms);
    const iv = setInterval(() => {
      if (state.abort) {
        clearTimeout(t);
        clearInterval(iv);
        rej(new Aborted("interrupted"));
      }
    }, 100);
  });
}

/** "1.5" whole tokens -> raw units for `decimals`. */
function toRaw(amount, decimals) {
  const [w, f = ""] = String(amount).split(".");
  if (f.length > decimals) throw new Error(`${amount} has more than ${decimals} decimals`);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

// ------------------------------------------------------------------ config and RPC

function loadNetworks(o) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(o.configPath, "utf8"));
  } catch (e) {
    if (o.configExplicit) throw new Error(`can't read --config ${o.configPath}: ${e.message}`);
    warn(`can't read ${o.configPath} (${e.message}); using RPCs from the environment only`);
  }
  const nets = {};
  for (const [id, n] of Object.entries(cfg.networks || {})) nets[Number(id)] = { ...n };
  const reactiveId = Number(cfg.lasnaChainId || (o.mainnet ? REACTIVE_MAINNET : LASNA));
  if (o.mainnet && reactiveId !== REACTIVE_MAINNET) throw new Error(`--mainnet, but ${o.configPath} is for chain ${reactiveId}`);
  if (!o.configExplicit) {
    for (const [id, env] of Object.entries(ENV_RPC[netOf(reactiveId)])) if (process.env[env]) (nets[Number(id)] ??= {}).rpc = process.env[env];
  }
  for (const spec of o.rpcOverrides) {
    const m = /^(\d+)=(.+)$/.exec(spec);
    if (!m) throw new Error(`--rpc expects ID=URL, got ${spec}`);
    (nets[Number(m[1])] ??= {}).rpc = m[2];
  }
  for (const [id, n] of Object.entries(nets)) {
    n.name ??= `chain ${id}`;
    n.short ??= n.name;
  }
  return { cfg, nets, lasnaChainId: reactiveId, tripwire: o.tripwire || cfg.tripwire || null };
}

function makeRpc(nets, timeoutMs) {
  let id = 0;
  const transient = (msg) => /timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|fetch failed|429|50[0-9]|rate|limit|busy|header not found|unknown block/i.test(msg);
  async function once(chainId, method, params) {
    const url = (nets[chainId] || {}).rpc;
    if (!url) throw new Error(`no RPC for chain ${chainId}`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: ctl.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) {
        const e = new Error(j.error.message || JSON.stringify(j.error));
        e.rpcError = true;
        throw e;
      }
      return j.result;
    } catch (e) {
      throw new Error(e.name === "AbortError" ? "timeout" : e.message, { cause: e });
    } finally {
      clearTimeout(timer);
    }
  }
  return async function rpc(chainId, method, params = [], { retries = 3 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(chainId, method, params);
      } catch (e) {
        const reverted = /revert/i.test(e.message);
        if (attempt >= retries || reverted || !transient(e.message)) throw new Error(`${method} on ${chainId}: ${e.message}`);
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); // not abortable: restore() uses rpc after Ctrl-C
      }
    }
  };
}

// ------------------------------------------------------------------ on-chain reads

async function readDeployment(rpc, lasna, tripwire) {
  const call = (to, data) => rpc(lasna, "eth_call", [{ to, data }, "latest"]);
  const code = await rpc(lasna, "eth_getCode", [tripwire, "latest"]);
  if (!code || code === "0x") throw new Error(`no contract at ${tripwire} on chain ${lasna}`);
  const word = async (sel) => C.wordAddr(await call(tripwire, sel));
  const [hot, cold, cosigner] = await Promise.all([word(C.SELECTOR.HOT), word(C.SELECTOR.COLD), word(C.SELECTOR.COSIGNER)]);
  const cooldown = Number(C.toBig(await call(tripwire, C.SELECTOR.tripCooldown)));
  const ids = C.decodeUintArray(await call(tripwire, C.SELECTOR.chainIds)).map(Number);
  const chains = {};
  for (const id of ids) {
    const cc = C.decodeChainConfig(await call(tripwire, C.encodeCall(C.SELECTOR.chainConfig, id)));
    chains[id] = { guardian: cc.guardian, intent: cc.intent, panic: cc.panic, tokens: [] };
    for (const a of cc.tokens) {
      const th = C.toBig(await call(tripwire, C.encodeCall(C.SELECTOR.threshold, id, a)));
      chains[id].tokens.push({ address: lc(a), threshold: th });
    }
  }
  return { tripwire: lc(tripwire), hot, cold, cosigner, cooldown, chains };
}

async function readTokens(rpc, dep) {
  for (const [id, c] of Object.entries(dep.chains)) {
    const chainId = Number(id);
    const call = (to, data, from) => rpc(chainId, "eth_call", [{ to, data, ...(from ? { from } : {}) }, "latest"]);
    await Promise.all(
      c.tokens.map(async (t) => {
        const [sym, dec] = await Promise.allSettled([call(t.address, C.SELECTOR.symbol), call(t.address, C.SELECTOR.decimals)]);
        t.symbol = (sym.status === "fulfilled" && C.decodeString(sym.value)) || C.short(t.address);
        t.decimals = dec.status === "fulfilled" && dec.value !== "0x" ? Number(C.toBig(dec.value)) : 18;
        // Open mint = the demo MockERC20. Circle's USDC reverts for anyone but its minters.
        try {
          await rpc(chainId, "eth_call", [{ to: t.address, from: "0x0000000000000000000000000000000000000001", data: C.encodeCall(C.SELECTOR.mint, dep.hot, 1) }, "latest"], { retries: 1 });
          t.mintable = true;
        } catch {
          t.mintable = false;
        }
      }),
    );
  }
}

async function balanceOf(rpc, chainId, token, who) {
  return C.toBig(await rpc(chainId, "eth_call", [{ to: token, data: C.encodeCall(C.SELECTOR.balanceOf, who) }, "latest"]));
}

// ------------------------------------------------------------------ transactions (forge script, keys from env)

function broadcastDir() {
  const d = process.env.FOUNDRY_BROADCAST || "broadcast";
  return resolve(repo, d);
}

/** Runs one MODE of script/Measure.s.sol on `chainId` and returns the hashes it broadcast. */
function forgeStep(nets, chainId, mode, env, { timeoutMs = 300_000 } = {}) {
  const rpcUrl = (nets[chainId] || {}).rpc;
  if (!rpcUrl) throw new Error(`no RPC for chain ${chainId}`);
  const started = Date.now();
  return new Promise((res, rej) => {
    const child = spawn("forge", ["script", "script/Measure.s.sol:Measure", "--rpc-url", rpcUrl, "--broadcast"], {
      cwd: repo,
      env: { ...process.env, MODE: mode, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      rej(new Error(`forge: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const tail = redact(out).trim().split("\n").slice(-15).join("\n");
        return rej(new Error(`forge script MODE=${mode} on ${chainId} failed (${signal || "exit " + code}):\n${tail}`));
      }
      const file = join(broadcastDir(), "Measure.s.sol", String(chainId), "run-latest.json");
      try {
        if (statSync(file).mtimeMs < started - 1000) throw new Error("stale broadcast record");
        const b = JSON.parse(readFileSync(file, "utf8"));
        res({ hashes: (b.transactions || []).map((t) => lc(t.hash)).filter(Boolean), output: redact(out) });
      } catch (e) {
        rej(new Error(`forge script MODE=${mode} on ${chainId}: can't read ${file}: ${e.message}`));
      }
    });
  });
}

function runForgeBuild() {
  return new Promise((res, rej) => {
    const child = spawn("forge", ["build"], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => rej(new Error(`forge: ${e.message}`)));
    child.on("close", (code) => (code === 0 ? res() : rej(new Error("forge build failed:\n" + out.split("\n").slice(-20).join("\n")))));
  });
}

// ------------------------------------------------------------------ rows and statistics (shared with --fixture)

/** CSV rows for one trip of a Monitor view: one per requested destination chain (or one with no destination). */
function rowsFromTrip(trip, meta) {
  const o = trip.origin;
  const r = trip.reactive;
  const base = {
    run_id: meta.runId,
    utc: meta.utc,
    source: meta.source,
    scenario: meta.scenario || trip.reason,
    origin_chain: trip.originRef ? trip.originRef.chainId : meta.originChain,
    origin_tx: trip.originRef ? trip.originRef.txHash : meta.originTx || "",
    origin_log_index: trip.originRef ? trip.originRef.logIndex : "",
    origin_block: o ? o.blockNumber : meta.originBlock ?? "",
    origin_ms: o && o.ts != null ? o.ts : meta.originMs ?? "",
    origin_exact: o ? (o.tsExact ? 1 : 0) : meta.originExact ?? "",
    verdict: meta.verdict || "Tripped",
    trip_id: trip.tripId,
    reactive_tx: r ? r.txHash : "",
    reactive_block: r ? r.blockNumber : "",
    reactive_ms: r && r.ts != null ? r.ts : "",
    reactive_exact: r ? (r.tsExact ? 1 : 0) : "",
    wall_trigger_ms: meta.wall?.trigger ?? "",
    wall_origin_seen_ms: meta.wall?.origin ?? "",
    wall_reactive_seen_ms: meta.wall?.reactive ?? "",
  };
  const reqs = trip.requests.length ? trip.requests : [null];
  return reqs.map((q) => {
    const s = q ? trip.sweeps[q.chainId] : null;
    const done = s && (s.done || s.replayed);
    const status = meta.status || (q && done ? "ok" : q ? "timeout" : "no-sweep-requested");
    return {
      ...base,
      dest_chain: q ? q.chainId : "",
      sweep_tx: s ? s.txHash : "",
      sweep_block: s ? s.blockNumber ?? "" : "",
      sweep_ms: s && s.ts != null ? s.ts : "",
      sweep_exact: s ? (s.tsExact ? 1 : 0) : "",
      swept: s && s.done ? s.done.swept : "",
      skipped: s && s.done ? s.done.skipped : "",
      unhandled: s && s.done ? s.done.unhandled : "",
      wall_sweep_seen_ms: q ? meta.wall?.sweeps?.[q.chainId] ?? "" : "",
      status: s && s.replayed ? "replayed" : status,
      note: meta.note || "",
    };
  });
}

/** Linear interpolation between closest ranks (numpy's default), p in [0, 1]. */
function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

function fmtSeconds(ms, approx) {
  if (ms == null || !Number.isFinite(ms)) return "–";
  const s = ms / 1000;
  const txt = Math.abs(s) < 10 ? s.toFixed(2) : Math.abs(s) < 600 ? s.toFixed(1) : s.toFixed(0);
  return (approx ? "≈" : "") + txt + " s";
}

const numOr = (v) => (v === "" || v == null ? null : Number(v));

/** Groups CSV rows into runs and computes each hop's samples. */
function summarize(rows) {
  const runs = new Map();
  for (const r of rows) {
    if (!runs.has(r.run_id)) runs.set(r.run_id, []);
    runs.get(r.run_id).push(r);
  }
  const ok = [];
  const failed = [];
  for (const [id, rs] of runs) {
    const good = rs.every((r) => r.status === "ok") && rs.some((r) => r.dest_chain !== "");
    (good ? ok : failed).push({ id, rows: rs });
  }
  const groups = new Map(); // origin chain -> hop key -> {samples, approx}
  const add = (origin, key, label, order, ms, approx) => {
    if (ms == null || !Number.isFinite(ms)) return;
    if (!groups.has(origin)) groups.set(origin, new Map());
    const g = groups.get(origin);
    if (!g.has(key)) g.set(key, { label, order, samples: [], approx: false });
    const h = g.get(key);
    h.samples.push(ms);
    h.approx ||= approx;
  };
  for (const run of ok) {
    const f = run.rows[0];
    const origin = Number(f.origin_chain);
    const oMs = numOr(f.origin_ms);
    const rMs = numOr(f.reactive_ms);
    const oEx = f.origin_exact === "1" || f.origin_exact === 1;
    const rEx = f.reactive_exact === "1" || f.reactive_exact === 1;
    if (oMs != null && rMs != null) add(origin, "react", "origin block → Reactive block (`Tripped`)", 0, rMs - oMs, !(oEx && rEx));
    let last = null;
    let lastApprox = false;
    let wallLast = null;
    for (const r of run.rows) {
      const sMs = numOr(r.sweep_ms);
      const sEx = r.sweep_exact === "1" || r.sweep_exact === 1;
      const dest = Number(r.dest_chain);
      if (sMs != null && rMs != null) add(origin, "sweep:" + dest, { dest }, 1, sMs - rMs, !(sEx && rEx));
      if (sMs != null && oMs != null && (last == null || sMs - oMs > last)) {
        last = sMs - oMs;
        lastApprox = !(sEx && oEx);
      }
      const w = numOr(r.wall_sweep_seen_ms);
      if (w != null && (wallLast == null || w > wallLast)) wallLast = w;
    }
    if (last != null) add(origin, "e2e", "**origin block → last sweep block (end to end)**", 2, last, lastApprox);
    const wOrigin = numOr(f.wall_origin_seen_ms);
    if (wallLast != null && wOrigin != null) add(origin, "wall", "wall clock: origin receipt → last `SweepDone` seen", 3, wallLast - wOrigin, false);
  }
  return { runs: runs.size, ok, failed, groups };
}

function chainName(nets, id) {
  const n = nets[id] || {};
  return n.name || `chain ${id}`;
}

/** Markdown block for the README (between the markers), from all CSV rows. */
function renderTable(rows, nets, { simulated = false, csvRel = null } = {}) {
  const S = summarize(rows);
  const lines = [];
  const utcs = S.ok.map((r) => r.rows[0].utc).filter(Boolean).sort();
  const span = utcs.length ? `${utcs[0].slice(0, 16).replace("T", " ")} to ${utcs[utcs.length - 1].slice(0, 16).replace("T", " ")} UTC` : "";
  const sources = [...new Set(rows.map((r) => r.source))].join(", ");
  if (simulated) {
    lines.push(`**Simulated, not measured.** Computed from \`demo/fixture.json\`, whose timestamps are synthetic; this only shows the table format. Run \`node tools/measure.mjs\` on the deployment for real numbers.`, "");
  } else {
    lines.push(`${S.ok.length} run${S.ok.length === 1 ? "" : "s"} measured (${sources}${span ? ", " + span : ""})${S.failed.length ? `; ${S.failed.length} more failed or timed out and are left out (status in the CSV)` : ""}.${csvRel ? ` Every run with its transaction hashes: [\`${csvRel}\`](${csvRel}).` : ""}`, "");
  }
  lines.push("| From | Hop | Runs | Median | p90 | Max |", "|---|---|---|---|---|---|");
  const origins = [...S.groups.keys()].sort((a, b) => order(a) - order(b));
  for (const origin of origins) {
    const hops = [...S.groups.get(origin).entries()].sort((a, b) => a[1].order - b[1].order || order(Number(a[0].split(":")[1])) - order(Number(b[0].split(":")[1])));
    for (const [, h] of hops) {
      const label = typeof h.label === "object" ? `Reactive block → sweep block on ${chainName(nets, h.label.dest)}` : h.label;
      const max = Math.max(...h.samples);
      lines.push(`| ${chainName(nets, origin)} | ${label} | ${h.samples.length} | ${fmtSeconds(percentile(h.samples, 0.5), h.approx)} | ${fmtSeconds(percentile(h.samples, 0.9), h.approx)} | ${fmtSeconds(max, h.approx)} |`);
    }
  }
  if (!origins.length) lines.push("| – | no complete run yet | 0 | – | – | – |");
  lines.push(
    "",
    "Times are the timestamps of the blocks that include each step. Base blocks carry milliseconds; Reactive Network, Ethereum and Unichain blocks only whole seconds, so hops that touch them are marked ≈ (±1 s); a small negative value means two chains' clocks disagree by that much. p90 interpolates between the closest runs. The wall-clock row is what a watcher polling every second saw, from the origin receipt to the last Guardian's `SweepDone`.",
  );
  return { text: lines.join("\n"), summary: S };
}

function order(id) {
  const i = CHAIN_ORDER.indexOf(id);
  return i < 0 ? 99 : i;
}

function writeReadme(path, block) {
  const src = readFileSync(path, "utf8");
  const b = src.indexOf(MARK_BEGIN);
  const e = src.indexOf(MARK_END);
  if (b < 0 || e < 0 || e < b) throw new Error(`${path} has no ${MARK_BEGIN} … ${MARK_END} markers`);
  const lineEnd = src.indexOf("\n", b);
  const out = src.slice(0, lineEnd + 1) + block + "\n" + src.slice(e);
  if (out !== src) writeFileSync(path, out);
}

// ------------------------------------------------------------------ CSV

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function readCsv(path) {
  if (!existsSync(path)) return [];
  const [head, ...body] = parseCsv(readFileSync(path, "utf8")).filter((r) => r.length > 1);
  if (!head) return [];
  if (head.join(",") !== CSV_COLUMNS.join(",")) throw new Error(`${path} has other columns than this version writes; move it away or pass --fresh`);
  return body.map((r) => Object.fromEntries(CSV_COLUMNS.map((c, i) => [c, r[i] ?? ""])));
}

function writeCsv(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n");
}

// ------------------------------------------------------------------ fixture mode

function fixtureMode(o) {
  const fx = JSON.parse(readFileSync(o.fixtureFile, "utf8"));
  const { nets } = loadNetworks({ ...o, configExplicit: false });
  const ctx = C.makeContext(fx.config);
  const m = new C.Monitor(ctx);
  m.ingest(fx.logs);
  const rows = [];
  for (const trip of m.view().trips) {
    rows.push(...rowsFromTrip(trip, { runId: `fixture-${trip.tripId}`, utc: new Date(trip.origin ? trip.origin.ts : 0).toISOString(), source: o.source || "fixture" }));
  }
  const all = o.csvExplicit && !o.fresh ? [...readCsv(o.csvPath), ...rows] : rows;
  if (o.csvExplicit) writeCsv(o.csvPath, all);
  const { text, summary } = renderTable(all, nets, { simulated: true, csvRel: o.csvExplicit ? relative(o.readmePath ? dirname(o.readmePath) : repo, o.csvPath) : null });
  if (o.readmeExplicit) writeReadme(o.readmePath, text);
  log(text);
  log(`\n${summary.ok.length} trip(s) from ${shown(o.fixtureFile)}${o.csvExplicit ? `, CSV ${o.csvPath}` : ""}${o.readmeExplicit ? `, table written to ${o.readmePath}` : ""}`);
  return 0;
}

// ------------------------------------------------------------------ live mode

function originList(o, dep, reactiveId) {
  const ids = Object.keys(dep.chains).map(Number).sort((a, b) => order(a) - order(b));
  if (!o.origin) return [ids[0]];
  if (o.origin === "all") return ids;
  const id = chainAlias(o.origin, reactiveId);
  if (!dep.chains[id]) throw new Error(`--origin ${o.origin}: chain ${id} isn't protected by this Tripwire (${ids.join(", ")})`);
  return [id];
}

function pickToken(o, dep, chainId) {
  const toks = dep.chains[chainId].tokens;
  if (!toks.length) throw new Error(`no tokens registered on chain ${chainId}`);
  if (o.token) {
    const t = toks.find((x) => x.address === lc(o.token) || lc(x.symbol) === lc(o.token));
    if (!t) throw new Error(`--token ${o.token} isn't registered on chain ${chainId} (${toks.map((x) => x.symbol).join(", ")})`);
    return t;
  }
  return toks.find((x) => x.mintable) || toks[0];
}

function requiredKeys(o, needMint) {
  const keys = [];
  if (!o.keepCooldown) keys.push("PRIVATE_KEY");
  if (needMint) keys.push("PRIVATE_KEY");
  keys.push(o.scenario === "panic" ? "COSIGNER_PK" : "HOT_PK");
  if (o.refill) keys.push("COLD_PK");
  return [...new Set(keys)];
}

async function setCooldown(nets, lasna, tripwire, value) {
  await forgeStep(nets, lasna, "cooldown", { TRIPWIRE: tripwire, COOLDOWN: String(value) });
}

/** Mints open-mint tokens up to the target and, with --refill, brings COLD's faucet tokens back to HOT. */
async function prepare(o, ctx) {
  const { rpc, nets, dep } = ctx;
  for (const [id, c] of Object.entries(dep.chains)) {
    const chainId = Number(id);
    const mintToks = [];
    const mintAmts = [];
    const refill = [];
    for (const t of c.tokens) {
      const bal = await balanceOf(rpc, chainId, t.address, dep.hot);
      if (t.mintable) {
        const target = toRaw(o.mint, t.decimals);
        if (bal < target) {
          mintToks.push(t.address);
          mintAmts.push((target - bal).toString());
        }
      } else if (o.refill && (await balanceOf(rpc, chainId, t.address, dep.cold)) > 0n) refill.push(t.address);
    }
    if (mintToks.length) await forgeStep(nets, chainId, "mint", { HOT: dep.hot, TOKENS: mintToks.join(","), AMOUNTS: mintAmts.join(",") });
    if (refill.length) await forgeStep(nets, chainId, "refill", { HOT: dep.hot, TOKENS: refill.join(",") });
  }
}

async function blockTime(ctx, chainId, blockNumber) {
  const cache = (ctx.blockTs[chainId] ??= {});
  if (cache[blockNumber]) return cache[blockNumber];
  const blk = await ctx.rpc(chainId, "eth_getBlockByNumber", ["0x" + Number(blockNumber).toString(16), false]);
  if (!blk) throw new Error(`block ${blockNumber} on ${chainId} not found`);
  const exact = blk.timestampMs != null;
  return (cache[blockNumber] = { ms: exact ? C.toNum(blk.timestampMs) : C.toNum(blk.timestamp) * 1000, exact });
}

/** New logs since the chain's cursor, chunked to the RPC's block range, with block timestamps attached. */
async function pollLogs(ctx, chainId, cursor, filter) {
  const latest = C.toNum(await ctx.rpc(chainId, "eth_blockNumber", []));
  const range = (ctx.nets[chainId] || {}).maxRange || 1000;
  const out = [];
  let from = cursor.next;
  while (from <= latest) {
    const to = Math.min(latest, from + range - 1);
    const logs = await ctx.rpc(chainId, "eth_getLogs", [{ ...filter, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
    for (const l of logs) {
      const bn = C.toNum(l.blockNumber);
      const t = await blockTime(ctx, chainId, bn);
      out.push({ ...l, chainId, blockTimestampMs: t.ms, tsExact: t.exact });
    }
    from = to + 1;
  }
  cursor.next = from;
  return out;
}

async function oneRun(o, ctx, i, originChain) {
  const { rpc, nets, dep, lasna } = ctx;
  const runId = `${ctx.sessionId}-${String(i + 1).padStart(2, "0")}`;
  const meta = { runId, utc: isoNow(), source: o.source || "live", scenario: o.scenario, originChain, wall: { sweeps: {} } };
  // With a trip, each destination keeps its own status (a landed sweep stays "ok", a missing one is "timeout").
  const fail = (status, note, trip) => (trip ? rowsFromTrip(trip, { ...meta, note }) : [blankRow(meta, status, note)]);

  if (o.mint !== "0" || o.refill) await prepare(o, ctx);

  // trigger parameters
  const c = dep.chains[originChain];
  let env;
  let mode;
  let match;
  if (o.scenario === "panic") {
    if (!c.panic || ZERO.test(c.panic)) throw new Error(`no PanicButton on chain ${originChain}`);
    mode = "panic";
    env = { PANIC: c.panic };
    match = (l) => lc(l.address) === lc(c.panic) && lc(l.topics[0]) === C.TOPIC.Panic && C.wordAddr(l.topics[1]) === lc(dep.cosigner);
  } else {
    const t = pickToken(o, dep, originChain);
    const amount = toRaw(o.amount, t.decimals);
    if (amount <= t.threshold) throw new Error(`--amount ${o.amount} ${t.symbol} is at or under its threshold (${C.formatUnits(t.threshold, t.decimals, 6)}): it wouldn't trip`);
    if (o.scenario === "transfer") {
      const bal = await balanceOf(rpc, originChain, t.address, dep.hot);
      if (bal < amount) throw new Error(`HOT holds ${C.formatUnits(bal, t.decimals, 6)} ${t.symbol} on ${originChain}, needs ${o.amount}${t.mintable ? "" : " (faucet token: get more from faucet.circle.com, or pass --refill with COLD_PK)"}`);
    }
    mode = o.scenario === "transfer" ? "move" : "approve";
    env = { TOKEN: t.address, TO: o.to, AMOUNT: amount.toString() };
    const topic = o.scenario === "transfer" ? C.TOPIC.Transfer : C.TOPIC.Approval;
    match = (l) => lc(l.address) === t.address && lc(l.topics[0]) === topic && C.wordAddr(l.topics[1]) === lc(dep.hot);
    meta.note = `${o.scenario} ${o.amount} ${t.symbol}`;
  }

  // cursors just before the trigger
  const cursors = {};
  for (const id of [lasna, ...Object.keys(dep.chains).map(Number)]) cursors[id] = { next: C.toNum(await rpc(id, "eth_blockNumber", [])) + 1 };

  const monitor = new C.Monitor(ctx.mctx);
  meta.wall.trigger = Date.now();
  const deadline = meta.wall.trigger + o.timeoutMs;
  const { hashes } = await forgeStep(nets, originChain, mode, env);
  meta.wall.origin = Date.now();
  const originTx = hashes[hashes.length - 1];
  if (!originTx) throw new Error("forge broadcast no transaction");
  meta.originTx = originTx;

  let receipt = null;
  while (!receipt) {
    receipt = await rpc(originChain, "eth_getTransactionReceipt", [originTx]);
    if (!receipt) {
      if (Date.now() > deadline) return fail("timeout", "origin tx not mined");
      await sleep(o.pollMs);
    }
  }
  if (receipt.status !== "0x1") return fail("error", "origin tx reverted");
  const bt = await blockTime(ctx, originChain, C.toNum(receipt.blockNumber));
  const originLogs = receipt.logs.map((l) => ({ ...l, chainId: originChain, blockTimestampMs: bt.ms, tsExact: bt.exact }));
  const trigger = originLogs.find(match);
  if (!trigger) throw new Error(`origin tx ${originTx} has no ${mode} log from the watched wallet: is ${o.scenario === "panic" ? "COSIGNER_PK the cosigner's" : "HOT_PK HOT's"} key?`);
  const trigIdx = C.toNum(trigger.logIndex);
  Object.assign(meta, { originBlock: C.toNum(receipt.blockNumber), originMs: bt.ms, originExact: bt.exact ? 1 : 0 });
  monitor.ingest(originLogs);
  log(`  origin   ${chainName(nets, originChain)} ${originTx} block ${meta.originBlock}`);

  let tripId = null;
  let requests = null;
  const sweptChains = new Set();
  const destFilter = (id) => ({ address: dep.chains[id].guardian, topics: [[C.TOPIC.Swept, C.TOPIC.Skipped, C.TOPIC.SweepDone, C.TOPIC.Replayed], C.numTopic(tripId)] });
  const tripOf = () => monitor.view().trips.find((t) => t.tripId === tripId);

  for (;;) {
    if (Date.now() > deadline) {
      const trip = tripId != null ? tripOf() : null;
      log(`  timeout after ${o.timeoutMs / 1000} s (${tripId == null ? "no verdict on Reactive Network" : `${sweptChains.size}/${requests.length} sweeps`})`);
      return fail("timeout", [meta.note, `timed out after ${o.timeoutMs / 1000} s`].filter(Boolean).join("; "), trip);
    }
    // Reactive Network: the verdict for our log, then the trip and its sweep requests.
    if (tripId == null) {
      const logs = await pollLogs(ctx, lasna, cursors[lasna], { address: dep.tripwire });
      monitor.ingest(logs);
      for (const l of logs) {
        const ev = C.decodeLog(ctx.mctx, l);
        if (!ev || lc(ev.originTx) !== originTx || ev.originLogIndex !== trigIdx || ev.originChainId !== originChain) continue;
        if (ev.name === "Observed" && ev.verdict !== "Tripped") {
          meta.verdict = ev.verdict;
          log(`  verdict  ${ev.verdict}: no trip`);
          return [blankRow(meta, "not-tripped", [meta.note, `verdict ${ev.verdict}`].filter(Boolean).join("; "))];
        }
        if (ev.name === "Tripped") {
          tripId = ev.tripId;
          meta.wall.reactive = Date.now();
          log(`  reactive trip #${tripId} ${ev.txHash}`);
        }
      }
      if (tripId != null) {
        requests = monitor.view().events.filter((e) => e.name === "SweepRequested" && e.tripId === tripId).map((e) => e.destChainId);
        if (!requests.length) return fail("no-sweep-requested", "no Guardian configured", tripOf());
      }
    }
    // Destinations: SweepDone (or Replayed) for this trip from each Guardian.
    if (tripId != null) {
      for (const id of requests) {
        if (sweptChains.has(id)) continue;
        const logs = await pollLogs(ctx, id, cursors[id], destFilter(id));
        monitor.ingest(logs);
        for (const l of logs) {
          const t0 = lc(l.topics[0]);
          if (t0 === C.TOPIC.SweepDone || t0 === C.TOPIC.Replayed) {
            sweptChains.add(id);
            meta.wall.sweeps[id] = Date.now();
            log(`  sweep    ${chainName(nets, id)} ${l.transactionHash}`);
          }
        }
      }
      if (sweptChains.size === requests.length) break;
    }
    await sleep(o.pollMs);
  }
  const trip = tripOf();
  const rows = rowsFromTrip(trip, meta);
  const lat = trip.latency;
  log(`  latency  → Reactive ${C.formatMs(lat.toReactive, lat.toReactiveApprox)}, → all swept ${C.formatMs(lat.allSwept, true)}`);
  return rows;
}

function blankRow(meta, status, note) {
  const r = Object.fromEntries(CSV_COLUMNS.map((c) => [c, ""]));
  return Object.assign(r, {
    run_id: meta.runId,
    utc: meta.utc,
    source: meta.source,
    scenario: meta.scenario,
    origin_chain: meta.originChain,
    origin_tx: meta.originTx || "",
    origin_block: meta.originBlock ?? "",
    origin_ms: meta.originMs ?? "",
    origin_exact: meta.originExact ?? "",
    verdict: meta.verdict || "",
    wall_trigger_ms: meta.wall?.trigger ?? "",
    wall_origin_seen_ms: meta.wall?.origin ?? "",
    status,
    note: note || "",
  });
}

async function setup(o) {
  const { nets, lasnaChainId: lasna, tripwire } = loadNetworks(o);
  const rpc = makeRpc(nets, o.rpcTimeoutMs);
  return { nets, lasna, tripwire, rpc, blockTs: {} };
}

function printPlan(o, ctx, dep, origins, problems) {
  const n = ctx.nets;
  log("Plan (dry run: nothing is sent)\n");
  log(`  RPCs        ${[ctx.lasna, ...(dep ? Object.keys(dep.chains).map(Number) : Object.keys(ENV_RPC[netOf(ctx.lasna)]).map(Number).filter((id) => id !== ctx.lasna)).sort((a, b) => order(a) - order(b))].map((id) => `${(n[id] || {}).short || id}=${(n[id] || {}).rpc || "MISSING"}`).join("  ")}`);
  log(`  Tripwire    ${ctx.tripwire || `<not deployed: set --tripwire, $TRIPWIRE or "tripwire" in ${shown(o.configPath)}>`}`);
  if (dep) {
    log(`  HOT ${dep.hot}  COLD ${dep.cold}  cosigner ${dep.cosigner}`);
    for (const [id, c] of Object.entries(dep.chains)) {
      const toks = c.tokens.map((t) => `${t.symbol}(${t.decimals}${t.mintable ? ", open mint" : ", faucet"}${t.threshold ? `, threshold ${C.formatUnits(t.threshold, t.decimals, 6)}` : ""})`).join(" ");
      log(`  ${chainName(n, Number(id)).padEnd(18)} Guardian ${c.guardian}  ${toks}`);
    }
  }
  const cd = dep ? dep.cooldown : "<current>";
  log("");
  if (o.keepCooldown) log(`  0. leave tripCooldown at ${cd} s (--keep-cooldown)`);
  else log(`  0. ${chainName(n, ctx.lasna)}: setTripCooldown(0) as the owner (PRIVATE_KEY), was ${cd} s; restored to ${cd} at the end, on error or Ctrl-C`);
  log(`  for each of ${o.runs} run(s), origin ${origins.map((id) => chainName(n, id)).join(" → ")} in turn:`);
  if (o.mint !== "0") log(`    a. top HOT up to ${o.mint} whole tokens of every open-mint token on every chain (MODE=mint, PRIVATE_KEY)`);
  if (o.refill) log(`    a'. COLD sends its faucet-token balances back to HOT (MODE=refill, COLD_PK)`);
  const what = o.scenario === "panic" ? "cosigner presses panic (MODE=panic, COSIGNER_PK)" : `HOT ${o.scenario === "transfer" ? "sends" : "approves"} ${o.amount} ${o.token || "<first open-mint token>"} ${o.scenario === "transfer" ? "to" : "for"} ${o.to} (MODE=${o.scenario === "transfer" ? "move" : "approve"}, HOT_PK)`;
  log(`    b. trigger: ${what}`);
  log(`    c. poll every ${o.pollMs} ms: ${chainName(n, ctx.lasna)} for Observed/Tripped of that log, each Guardian for SweepDone(tripId); give up after ${o.timeoutMs / 1000} s`);
  log(`    d. append rows to ${o.csvPath ? shown(o.csvPath) : "-"}; wait ${o.gapMs / 1000} s`);
  log(`  then: median/p90 table from the whole CSV → ${o.readmePath ? shown(o.readmePath) : "(no README)"} between the measure:latency markers`);
  log(`  forge broadcast records: ${shown(broadcastDir())}/Measure.s.sol/<chain>/`);
  if (problems.length) log("\nWould stop before sending anything:\n  - " + problems.join("\n  - "));
  else log("\nReady.");
}

async function liveMode(o) {
  const ctx = await setup(o);
  const problems = [];
  let dep = null;
  let origins = [];
  if (!ctx.tripwire) problems.push("no Tripwire address");
  else {
    try {
      dep = await readDeployment(ctx.rpc, ctx.lasna, ctx.tripwire);
      await readTokens(ctx.rpc, dep);
      origins = originList(o, dep, ctx.lasna);
      if (o.scenario !== "panic") for (const id of origins) pickToken(o, dep, id);
      if (lc(o.to) === lc(dep.cold)) problems.push("--to is COLD: that never trips");
      const trusted = C.toBig(await ctx.rpc(ctx.lasna, "eth_call", [{ to: dep.tripwire, data: C.encodeCall(C.SELECTOR.trusted, o.to) }, "latest"]));
      if (trusted) problems.push(`--to ${o.to} is trusted on the Tripwire: that never trips`);
      for (const id of origins) {
        const g = dep.chains[id].guardian;
        if (!g || ZERO.test(g)) problems.push(`no Guardian set for chain ${id}`);
        if (lc(o.to) === lc(g)) problems.push("--to is a Guardian");
      }
    } catch (e) {
      problems.push(`deployment not readable: ${e.message}`);
    }
  }
  const needMint = o.mint !== "0" && (!dep || Object.values(dep.chains).some((c) => c.tokens.some((t) => t.mintable)));
  const missing = requiredKeys(o, needMint).filter((k) => !process.env[k]);
  if (missing.length) problems.push(`missing env: ${missing.join(", ")}`);
  if (dep) {
    for (const [id, c] of Object.entries(dep.chains)) {
      if (!c.guardian || ZERO.test(c.guardian)) continue;
      for (const t of c.tokens) {
        try {
          const a = C.toBig(await ctx.rpc(Number(id), "eth_call", [{ to: t.address, data: C.encodeCall(C.SELECTOR.allowance, dep.hot, c.guardian) }, "latest"]));
          if (a < 1n << 128n) warn(`${t.symbol} on ${id}: HOT's allowance to the Guardian is ${C.formatUnits(a, t.decimals)}; run script/Arm.s.sol or it is skipped in sweeps`);
        } catch (e) {
          warn(`allowance of ${t.symbol} on ${id}: ${e.message}`);
        }
      }
    }
  }
  if (o.dryRun) {
    if (!origins.length) origins = o.origin && o.origin !== "all" ? [chainAlias(o.origin, ctx.lasna)] : [chainAlias("base", ctx.lasna)];
    printPlan(o, ctx, dep, origins, problems);
    return 0;
  }
  if (problems.length) throw new Error(problems.join("\n  "));

  ctx.dep = dep;
  ctx.mctx = C.makeContext({ lasnaChainId: ctx.lasna, tripwire: dep.tripwire, hot: dep.hot, cold: dep.cold, cosigner: dep.cosigner, chains: dep.chains });
  // Run ids are <session>-<n>; the session is to the second, and made unique against runs already in the CSV.
  ctx.sessionId = isoNow().replace(/[-:]/g, "").slice(0, 15) + "Z";
  log(`Tripwire ${dep.tripwire} on ${chainName(ctx.nets, ctx.lasna)}; ${o.runs} run(s), ${o.scenario} from ${origins.map((id) => chainName(ctx.nets, id)).join(", ")}`);
  await runForgeBuild();

  const prior = o.fresh ? [] : readCsv(o.csvPath);
  const usedIds = new Set(prior.map((r) => r.run_id.replace(/-\d+$/, "")));
  for (let k = 2; usedIds.has(ctx.sessionId); k++) ctx.sessionId = ctx.sessionId.replace(/(_\d+)?$/, "_" + k);
  const rows = [];
  let failedRuns = 0;
  const original = dep.cooldown;
  let changed = false;
  const restore = async () => {
    if (!changed) return;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await setCooldown(ctx.nets, ctx.lasna, dep.tripwire, original);
        const now = Number(C.toBig(await ctx.rpc(ctx.lasna, "eth_call", [{ to: dep.tripwire, data: C.SELECTOR.tripCooldown }, "latest"])));
        if (now === original) {
          changed = false;
          log(`tripCooldown restored to ${original} s`);
          return;
        }
        throw new Error(`reads ${now} after the restore`);
      } catch (e) {
        warn(`restoring tripCooldown (attempt ${attempt}/3): ${e.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
    }
    console.error(
      `\nCOULD NOT RESTORE tripCooldown to ${original} s. Restore it by hand:\n  MODE=cooldown TRIPWIRE=${dep.tripwire} COOLDOWN=${original} forge script script/Measure.s.sol:Measure --rpc-url ${ctx.nets[ctx.lasna].rpc} --broadcast\n`,
    );
  };
  ctx.restore = restore;
  ctx.cooldownInfo = () => ({ changed, original });

  try {
    if (!o.keepCooldown && original !== 0) {
      changed = true; // set before sending: a half-sent change is still restored
      await setCooldown(ctx.nets, ctx.lasna, dep.tripwire, 0);
      log(`tripCooldown 0 for the session (was ${original} s)`);
    }
    for (let i = 0; i < o.runs; i++) {
      const origin = origins[i % origins.length];
      log(`run ${i + 1}/${o.runs} from ${chainName(ctx.nets, origin)}`);
      let rs;
      try {
        rs = await oneRun(o, ctx, i, origin);
      } catch (e) {
        if (e instanceof Aborted) throw e;
        log(`  error: ${redact(e.message)}`);
        rs = [blankRow({ runId: `${ctx.sessionId}-${String(i + 1).padStart(2, "0")}`, utc: isoNow(), source: o.source || "live", scenario: o.scenario, originChain: origin }, "error", redact(e.message).split("\n")[0].slice(0, 200))];
        if (/missing env|isn't registered|threshold|HOT holds|no PanicButton/.test(e.message)) {
          rows.push(...rs);
          writeCsv(o.csvPath, [...prior, ...rows]);
          throw e; // the same on every run: stop
        }
      }
      if (rs.some((r) => r.status !== "ok")) failedRuns++;
      rows.push(...rs);
      writeCsv(o.csvPath, [...prior, ...rows]); // after every run, so an interruption keeps the data
      if (i < o.runs - 1) await sleep(o.gapMs);
    }
  } finally {
    await restore();
    if (rows.length || prior.length) {
      const all = [...prior, ...rows];
      if (!rows.length) writeCsv(o.csvPath, all);
      const csvRel = o.readmePath ? relative(dirname(o.readmePath), o.csvPath) : shown(o.csvPath);
      const { text, summary } = renderTable(all, ctx.nets, { csvRel });
      if (o.readmePath) {
        try {
          writeReadme(o.readmePath, text);
        } catch (e) {
          warn(e.message);
        }
      }
      log("\n" + text);
      const e2e = [];
      const react = [];
      for (const g of summary.groups.values()) {
        if (g.get("e2e")) e2e.push(...g.get("e2e").samples);
        if (g.get("react")) react.push(...g.get("react").samples);
      }
      log(`\nBUIDL: N_RUNS=${summary.ok.length} LAT_P50=${fmtSeconds(percentile(e2e, 0.5), true)} LAT_P90=${fmtSeconds(percentile(e2e, 0.9), true)} LAT_P95=${fmtSeconds(percentile(e2e, 0.95), true)} LAT_REACT_P50=${fmtSeconds(percentile(react, 0.5), true)}`);
      log(`CSV ${shown(o.csvPath)}${o.readmePath ? `, table in ${shown(o.readmePath)}` : ""}`);
    }
  }
  return failedRuns ? 2 : 0;
}

// ------------------------------------------------------------------ main

async function main() {
  let o;
  try {
    o = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(e.message + "\n\n" + HELP);
    return 1;
  }
  if (o.help) {
    log(HELP);
    return 0;
  }
  if (o.fixture) return fixtureMode(o);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return liveMode(o);
}

function onSignal() {
  state.sigints++;
  if (state.sigints === 1) {
    state.abort = true;
    console.error("\ninterrupted: restoring tripCooldown and writing what was measured (Ctrl-C again to quit at once)");
  } else {
    console.error("quitting without restoring: check tripCooldown() on Reactive Network and restore it with MODE=cooldown (see --help)");
    process.exit(130);
  }
}

// Exported for tests; run only when executed directly.
export { percentile, renderTable, rowsFromTrip, summarize, parseCsv, toRaw, CSV_COLUMNS };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e instanceof Aborted ? "interrupted" : "error: " + redact(e.message));
      process.exit(e instanceof Aborted ? 130 : 1);
    });
}
