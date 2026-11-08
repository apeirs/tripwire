// Tripwire demo: decoding and timeline model. No DOM, no network, no dependencies, so the same file runs in the
// page and under node (demo/tools/check.mjs). Event signatures match src/*.sol; check.mjs re-derives every topic and
// selector with `cast` and fails if one drifts.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TripwireCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // ------------------------------------------------------------------ ABI constants

  /** Event signatures, as declared in the contracts. */
  const SIGNATURES = {
    Transfer: "Transfer(address,address,uint256)", // ERC-20, origin chains
    Approval: "Approval(address,address,uint256)", // ERC-20, origin chains
    Intend: "Intend(address,address,address,uint256,uint64)", // Intent.sol
    Panic: "Panic(address)", // PanicButton.sol
    Observed: "Observed(uint256,uint256,address,uint256,uint8,uint256,uint256)", // TripwireReactive.sol
    Tripped: "Tripped(uint256,uint8,uint256,uint256,uint256)",
    TripMerged: "TripMerged(uint256,uint8,uint256,uint256,uint256)",
    SweepRequested: "SweepRequested(uint256,uint256,address,uint256)",
    IntentSet: "IntentSet(uint256,address,address,uint256,uint64)",
    Duplicate: "Duplicate(uint256,uint256,uint256)",
    Swept: "Swept(uint256,address,uint256)", // Guardian.sol
    Skipped: "Skipped(uint256,address,uint8)",
    SweepDone: "SweepDone(uint256,uint256,uint256,uint256)",
    Replayed: "Replayed(uint256)",
    Drained: "Drained(address,address,uint256)", // mocks/Drainer.sol (demo attacker)
  };

  /** keccak256 of each signature (checked against `cast keccak` by tools/check.mjs). */
  const TOPIC = {
    Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    Approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
    Intend: "0x8e4f070cc6cf5eecff91440bd35ab37a08452d8d9662b362754603a4ee3e0820",
    Panic: "0xa0281c9359a6afac738fb86a45f94a2482ed1f0bfbdf7ce5ef88046acf47160c",
    Observed: "0x63e5f6ccb73b24849ea4762a6c15a7e218fd0ad7784fa2bd378af76ab9acec8e",
    Tripped: "0xaa6701e298483b7d6796e8f119631ff8a4cf927ba1c650516551a3a41a610da9",
    TripMerged: "0xfc4d1a3b57f519e0c24fd993d2176865a4b330d04fae28c6dd883c500bbf7b44",
    SweepRequested: "0x78625e1b1840f194faa1e6e85ca37e1602c5dffb911a047b9de77fc71f2b60b1",
    IntentSet: "0xe837f29411d1efe18f0a710189f18e72b7273cb58087f6d8191925bd1084e590",
    Duplicate: "0x72153a0d937c9d9b40ca46ba00639da2150394ee5b0d5c7114fe4f66ba31d960",
    Swept: "0x635115695722305cd48dbad76225961b39079f2cf952cc198f13fb4904cf3512",
    Skipped: "0x451f6c4aebcec5b0829e8edf8ffd3beca371d621cad02d40849bbdf4fe3b4522",
    SweepDone: "0xc4f47909cba9367bb46194a7f7c5eb428cd6f0a47ad5871a140df9258be55f37",
    Replayed: "0x1f3abd952bb39ec1d1d011b716b5ed2b4d7636139a1c613f2b877495a44a8766",
    Drained: "0xbfd2431e6c719bec0308db4f4ed0afc39712d368867354c711a1ea1e384fa781",
  };
  const TOPIC_NAME = Object.fromEntries(Object.entries(TOPIC).map(([k, v]) => [v, k]));

  /** Function selectors used by the live poller. */
  const SELECTOR = {
    HOT: "0xdcbdadcc", // HOT()
    COLD: "0x5bc1eeb4", // COLD()
    COSIGNER: "0x49a72288", // COSIGNER()
    trips: "0xb826c4fd", // trips()
    chainIds: "0xfbe4b7c0", // chainIds()
    chainConfig: "0x0a70b056", // chainConfig(uint256)
    balanceOf: "0x70a08231", // balanceOf(address)
    allowance: "0xdd62ed3e", // allowance(address,address)
    decimals: "0x313ce567", // decimals()
    symbol: "0x95d89b41", // symbol()
    debt: "0x9b6c56ec", // debt(address)
    reserves: "0xd66bd524", // reserves(address): system contract / callback proxy deposits (depositTo)
    tripCooldown: "0xfd7375f9", // tripCooldown() (tools/measure.mjs)
    threshold: "0xd60dd2ca", // threshold(uint256,address)
    trusted: "0x6e9821c2", // trusted(address)
    mint: "0x40c10f19", // mint(address,uint256): open on the demo tokens, restricted on real ones
  };
  const SELECTOR_SIGNATURES = {
    HOT: "HOT()",
    COLD: "COLD()",
    COSIGNER: "COSIGNER()",
    trips: "trips()",
    chainIds: "chainIds()",
    chainConfig: "chainConfig(uint256)",
    balanceOf: "balanceOf(address)",
    allowance: "allowance(address,address)",
    decimals: "decimals()",
    symbol: "symbol()",
    debt: "debt(address)",
    reserves: "reserves(address)",
    tripCooldown: "tripCooldown()",
    threshold: "threshold(uint256,address)",
    trusted: "trusted(address)",
    mint: "mint(address,uint256)",
  };

  // Enum orders from the contracts.
  const REASON = ["Transfer", "Approval", "GuardianRevoked", "Panic"]; // TripwireReactive.Reason
  const VERDICT = ["Trusted", "UnderThreshold", "Intended", "Tripped", "Merged", "Ignored"]; // .Verdict
  const SKIP_REASON = ["NotAContract", "ReadFailed", "NothingToMove", "TransferFailed", "OutOfGas"]; // Guardian
  const GUARDIAN_ALLOWANCE_FLOOR = 1n << 128n;
  const REACTIVE_SYSTEM = "0x8888888888888888888888888888888888888888";

  // ------------------------------------------------------------------ hex helpers

  const norm = (a) => (a ? String(a).toLowerCase() : "");
  const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);
  const word = (data, i) => strip(data || "0x").slice(64 * i, 64 * (i + 1)).padEnd(64, "0");
  const toBig = (hex) => BigInt("0x" + (strip(hex) || "0"));
  const wordBig = (data, i) => toBig(word(data, i));
  const wordAddr = (hex) => "0x" + strip(hex).padStart(64, "0").slice(24);
  const toNum = (hex) => Number(toBig(hex));
  const pad32 = (v) => {
    if (typeof v === "string" && v.startsWith("0x") && v.length === 42) return strip(v).toLowerCase().padStart(64, "0");
    return BigInt(v).toString(16).padStart(64, "0");
  };
  /** ABI-encodes a call with static arguments (addresses and integers). */
  const encodeCall = (selector, ...args) => selector + args.map(pad32).join("");
  const addrTopic = (a) => "0x" + pad32(a);
  const numTopic = (n) => "0x" + pad32(n);

  function decodeUintArray(ret) {
    const d = strip(ret);
    const off = Number(toBig(d.slice(0, 64))) * 2;
    const n = Number(toBig(d.slice(off, off + 64)));
    const out = [];
    for (let i = 0; i < n; i++) out.push(toBig(d.slice(off + 64 + 64 * i, off + 128 + 64 * i)));
    return out;
  }

  /** chainConfig(uint256) returns (address guardian, address intent, address panicButton, address[] tokens). */
  function decodeChainConfig(ret) {
    const d = strip(ret);
    const base = Number(toBig(d.slice(0, 64))) * 2; // offset of the dynamic tuple
    const at = (i) => d.slice(base + 64 * i, base + 64 * (i + 1));
    const tokOff = base + Number(toBig(at(3))) * 2;
    const n = Number(toBig(d.slice(tokOff, tokOff + 64)));
    const tokens = [];
    for (let i = 0; i < n; i++) tokens.push(wordAddr(d.slice(tokOff + 64 + 64 * i, tokOff + 128 + 64 * i)));
    return { guardian: wordAddr(at(0)), intent: wordAddr(at(1)), panic: wordAddr(at(2)), tokens };
  }

  /** ABI string, with a fallback for old tokens that return bytes32. */
  function decodeString(ret) {
    const d = strip(ret || "0x");
    if (d.length === 64) return hexToUtf8(d).replace(/\0+$/, "");
    if (d.length < 128) return "";
    const off = Number(toBig(d.slice(0, 64))) * 2;
    const len = Number(toBig(d.slice(off, off + 64)));
    return hexToUtf8(d.slice(off + 64, off + 64 + len * 2));
  }
  function hexToUtf8(h) {
    const bytes = new Uint8Array(h.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(h.substr(i * 2, 2), 16);
    return new TextDecoder().decode(bytes);
  }

  // ------------------------------------------------------------------ formatting

  function formatUnits(value, decimals = 18, maxFrac = 4) {
    const v = BigInt(value);
    if (v >= GUARDIAN_ALLOWANCE_FLOOR) return "unlimited";
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const base = 10n ** BigInt(decimals);
    const whole = abs / base;
    let frac = (abs % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
    // Dust below the shown precision (1 micro-USDC at 4 places) reads "<0.0001", never a misleading "0".
    if (abs > 0n && whole === 0n && !frac) return (neg ? "-" : "") + "<0." + "0".repeat(Math.max(0, maxFrac - 1)) + "1";
    const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (neg ? "-" : "") + w + (frac ? "." + frac : "");
  }

  function formatMs(ms, approx) {
    if (ms == null || !isFinite(ms)) return "–";
    // Block clocks tick in whole seconds (Reactive) or differ by a little, so an approximate gap just under zero is
    // a rounding artefact: a later block can't really precede the one that caused it. Show it as "≈0 s".
    if (approx && ms < 0 && ms > -2000) return "≈0 s";
    const s = ms / 1000;
    const txt = Math.abs(s) < 10 ? s.toFixed(2) + " s" : Math.abs(s) < 120 ? s.toFixed(1) + " s" : (s / 60).toFixed(1) + " min";
    return (approx ? "≈" : "") + (ms >= 0 ? "+" : "") + txt;
  }

  const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

  // ------------------------------------------------------------------ context

  /**
   * Normalises a config into lookups the decoder needs.
   * cfg: { lasnaChainId, tripwire, hot, cold, cosigner, labels: {addr: label},
   *        chains: { [chainId]: { guardian, intent, panic, tokens: [{ address, symbol, decimals }] } } }
   */
  function makeContext(cfg) {
    const ctx = {
      lasnaChainId: Number(cfg.lasnaChainId || 5318007),
      tripwire: norm(cfg.tripwire),
      hot: norm(cfg.hot),
      cold: norm(cfg.cold),
      cosigner: norm(cfg.cosigner),
      chains: {},
      guardianChain: {},
      tokenMeta: {},
      labels: {},
    };
    for (const [addr, label] of Object.entries(cfg.labels || {})) ctx.labels[norm(addr)] = label;
    for (const [id, c] of Object.entries(cfg.chains || {})) {
      const chainId = Number(id);
      const tokens = (c.tokens || []).map((t) => (typeof t === "string" ? { address: t } : t));
      ctx.chains[chainId] = {
        guardian: norm(c.guardian),
        intent: norm(c.intent),
        panic: norm(c.panic),
        tokens: tokens.map((t) => norm(t.address)),
      };
      if (c.guardian) ctx.guardianChain[norm(c.guardian)] = chainId;
      ctx.tokenMeta[chainId] = {};
      for (const t of tokens) {
        ctx.tokenMeta[chainId][norm(t.address)] = { symbol: t.symbol || short(t.address), decimals: t.decimals ?? 18 };
      }
      if (c.guardian) ctx.labels[norm(c.guardian)] ??= "Guardian";
      if (c.intent) ctx.labels[norm(c.intent)] ??= "Intent";
      if (c.panic) ctx.labels[norm(c.panic)] ??= "PanicButton";
    }
    if (ctx.hot) ctx.labels[ctx.hot] = "HOT";
    if (ctx.cold) ctx.labels[ctx.cold] = "VAULT";
    if (ctx.cosigner) ctx.labels[ctx.cosigner] = ctx.cosigner === ctx.hot ? "HOT (cosigner)" : "cosigner";
    if (ctx.tripwire) ctx.labels[ctx.tripwire] = "TripwireReactive";
    return ctx;
  }

  const label = (ctx, a) => ctx.labels[norm(a)] || short(a);
  const tokenMeta = (ctx, chainId, token) =>
    (ctx.tokenMeta[chainId] || {})[norm(token)] || { symbol: short(token), decimals: 18 };
  const amountStr = (ctx, chainId, token, v) => {
    const m = tokenMeta(ctx, chainId, token);
    return formatUnits(v, m.decimals) + " " + m.symbol;
  };

  // ------------------------------------------------------------------ decoding

  /**
   * Decodes one RPC-style log ({ chainId, address, topics, data, transactionHash, logIndex, blockNumber,
   * blockTimestampMs }) into a typed event, or null if it isn't one this demo understands.
   */
  function decodeLog(ctx, log) {
    const name = TOPIC_NAME[norm(log.topics[0])];
    if (!name) return null;
    const t = log.topics;
    const d = log.data;
    const ev = {
      name,
      chainId: Number(log.chainId),
      address: norm(log.address),
      txHash: norm(log.transactionHash),
      logIndex: typeof log.logIndex === "string" ? toNum(log.logIndex) : Number(log.logIndex),
      blockNumber: typeof log.blockNumber === "string" ? toNum(log.blockNumber) : Number(log.blockNumber),
      ts: log.blockTimestampMs ?? null,
      tsExact: !!log.tsExact,
    };
    const onLasna = ev.chainId === ctx.lasnaChainId;
    switch (name) {
      case "Transfer":
        if (t.length !== 3) return null; // ERC-721 Transfer indexes the id as well
        return Object.assign(ev, { token: ev.address, from: norm(wordAddr(t[1])), to: norm(wordAddr(t[2])), value: wordBig(d, 0) });
      case "Approval":
        if (t.length !== 3) return null;
        return Object.assign(ev, { token: ev.address, owner: norm(wordAddr(t[1])), spender: norm(wordAddr(t[2])), value: wordBig(d, 0) });
      case "Intend":
        return Object.assign(ev, {
          owner: norm(wordAddr(t[1])),
          token: norm(wordAddr(t[2])),
          to: norm(wordAddr(t[3])),
          amount: wordBig(d, 0),
          expiry: Number(wordBig(d, 1)),
        });
      case "Panic":
        return Object.assign(ev, { caller: norm(wordAddr(t[1])) });
      case "Drained":
        return Object.assign(ev, { token: norm(wordAddr(t[1])), victim: norm(wordAddr(t[2])), amount: wordBig(d, 0) });
      case "Swept":
      case "Skipped":
      case "SweepDone":
      case "Replayed": {
        if (onLasna) return null;
        ev.tripId = Number(toBig(t[1]));
        if (name === "Swept") Object.assign(ev, { token: norm(wordAddr(t[2])), amount: wordBig(d, 0) });
        if (name === "Skipped") Object.assign(ev, { token: norm(wordAddr(t[2])), reason: SKIP_REASON[Number(wordBig(d, 0))] || "?" });
        if (name === "SweepDone") Object.assign(ev, { swept: Number(wordBig(d, 0)), skipped: Number(wordBig(d, 1)), unhandled: Number(wordBig(d, 2)) });
        return ev;
      }
      default:
        break;
    }
    if (!onLasna || (ctx.tripwire && ev.address !== ctx.tripwire)) return null;
    switch (name) {
      case "Observed":
        return Object.assign(ev, {
          originChainId: Number(toBig(t[1])),
          observedTopic: TOPIC_NAME[norm(t[2])] || "?",
          counterparty: norm(wordAddr(t[3])),
          amount: wordBig(d, 0),
          verdict: VERDICT[Number(wordBig(d, 1))] || "?",
          originTx: "0x" + word(d, 2),
          originLogIndex: Number(wordBig(d, 3)),
        });
      case "Tripped":
      case "TripMerged":
        return Object.assign(ev, {
          tripId: Number(toBig(t[1])),
          reason: REASON[Number(toBig(t[2]))] || "?",
          originChainId: Number(toBig(t[3])),
          originTx: "0x" + word(d, 0),
          originLogIndex: Number(wordBig(d, 1)),
        });
      case "SweepRequested":
        return Object.assign(ev, {
          tripId: Number(toBig(t[1])),
          destChainId: Number(toBig(t[2])),
          guardian: norm(wordAddr(word(d, 0))),
          tokens: Number(wordBig(d, 1)),
        });
      case "IntentSet":
        return Object.assign(ev, {
          originChainId: Number(toBig(t[1])),
          token: norm(wordAddr(t[2])),
          to: norm(wordAddr(t[3])),
          amount: wordBig(d, 0),
          expiry: Number(wordBig(d, 1)),
        });
      case "Duplicate":
        return Object.assign(ev, { originChainId: Number(toBig(t[1])), originTx: "0x" + word(d, 0), originLogIndex: Number(wordBig(d, 1)) });
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ timeline model

  const keyOf = (chainId, txHash, logIndex) => chainId + ":" + norm(txHash) + ":" + logIndex;

  class Monitor {
    constructor(ctx) {
      this.ctx = ctx;
      this.events = [];
      this.byKey = new Map();
    }

    /** Adds raw logs; returns how many were new and understood. */
    ingest(logs) {
      let added = 0;
      for (const log of logs) {
        const k = keyOf(Number(log.chainId), log.transactionHash, typeof log.logIndex === "string" ? toNum(log.logIndex) : log.logIndex);
        if (this.byKey.has(k)) {
          const prev = this.byKey.get(k);
          if (prev && prev.ts == null && log.blockTimestampMs != null) Object.assign(prev, { ts: log.blockTimestampMs, tsExact: !!log.tsExact });
          continue;
        }
        const ev = decodeLog(this.ctx, log);
        this.byKey.set(k, ev);
        if (ev) {
          this.events.push(ev);
          added++;
        }
      }
      if (added) this.events.sort(cmpEvents);
      return added;
    }

    /** Fills in a block timestamp found later (live mode fetches blocks lazily). */
    setTimestamp(chainId, blockNumber, ms, exact) {
      for (const ev of this.events) {
        if (ev.chainId === chainId && ev.blockNumber === blockNumber && ev.ts == null) {
          ev.ts = ms;
          ev.tsExact = exact;
        }
      }
      this.events.sort(cmpEvents);
    }

    /** Builds everything the page renders. */
    view() {
      const ctx = this.ctx;
      const evs = this.events;
      const trips = new Map();
      const sweepTxs = new Set();
      const origin = new Map(); // key -> origin event

      for (const ev of evs) {
        if (["Transfer", "Approval", "Intend", "Panic"].includes(ev.name)) origin.set(keyOf(ev.chainId, ev.txHash, ev.logIndex), ev);
        if (ev.name === "Swept" || ev.name === "SweepDone" || ev.name === "Skipped" || ev.name === "Replayed") sweepTxs.add(ev.chainId + ":" + ev.txHash);
      }
      const tripOf = (id) => {
        if (!trips.has(id)) trips.set(id, { tripId: id, requests: [], sweeps: {}, merged: [], reactive: null, origin: null });
        return trips.get(id);
      };

      for (const ev of evs) {
        if (ev.name === "Tripped") {
          const trip = tripOf(ev.tripId);
          trip.reason = ev.reason;
          trip.reactive = { chainId: ev.chainId, txHash: ev.txHash, ts: ev.ts, tsExact: ev.tsExact, blockNumber: ev.blockNumber };
          trip.originRef = { chainId: ev.originChainId, txHash: ev.originTx, logIndex: ev.originLogIndex };
          trip.origin = origin.get(keyOf(ev.originChainId, ev.originTx, ev.originLogIndex)) || null;
        } else if (ev.name === "TripMerged") {
          // A move folded into this trip: recorded on Reactive, no new sweep requested.
          tripOf(ev.tripId).merged.push({
            reason: ev.reason,
            chainId: ev.originChainId,
            txHash: ev.originTx,
            logIndex: ev.originLogIndex,
            origin: origin.get(keyOf(ev.originChainId, ev.originTx, ev.originLogIndex)) || null,
          });
        } else if (ev.name === "SweepRequested") {
          tripOf(ev.tripId).requests.push({ chainId: ev.destChainId, guardian: ev.guardian, tokens: ev.tokens });
        } else if (["Swept", "Skipped", "SweepDone", "Replayed"].includes(ev.name)) {
          // The chain a log came from decides, not the Guardian's address: one deployer with the same nonces on two
          // chains gets the same Guardian address on both, and an address -> chain map would fold their sweeps
          // into one chain. guardianChain is only the fallback for a log without a chainId.
          const chainId = ev.chainId ?? ctx.guardianChain[ev.address];
          if (Object.keys(ctx.guardianChain).length) {
            const ours = ev.chainId != null ? (ctx.chains[ev.chainId] || {}).guardian === ev.address : ctx.guardianChain[ev.address] != null;
            if (!ours) continue; // not our Guardian on that chain
          }
          const s = (tripOf(ev.tripId).sweeps[chainId] ??= { chainId, txHash: ev.txHash, blockNumber: ev.blockNumber, ts: ev.ts, tsExact: ev.tsExact, swept: [], skipped: [], done: null, replayed: false });
          if (s.ts == null) s.ts = ev.ts;
          if (ev.name === "Swept") s.swept.push({ token: ev.token, amount: ev.amount });
          if (ev.name === "Skipped") s.skipped.push({ token: ev.token, reason: ev.reason });
          if (ev.name === "SweepDone") s.done = { swept: ev.swept, skipped: ev.skipped, unhandled: ev.unhandled };
          if (ev.name === "Replayed") s.replayed = true;
        }
      }

      // Verdicts: Observed names its origin log (chain, tx, log index), so each links to its move exactly. A merged
      // verdict also gets the trip it was folded into, from the TripMerged event with the same origin log.
      const matched = new Set();
      const verdictOf = new Map();
      const mergedInto = new Map();
      for (const ev of evs) if (ev.name === "TripMerged") mergedInto.set(keyOf(ev.originChainId, ev.originTx, ev.originLogIndex), ev.tripId);
      for (const ev of evs) {
        if (ev.name === "Observed") {
          const k = keyOf(ev.originChainId, ev.originTx, ev.originLogIndex);
          const o = origin.get(k);
          if (o && o.name === ev.observedTopic) {
            matched.add(o);
            verdictOf.set(o, mergedInto.has(k) ? Object.assign(ev, { mergedInto: mergedInto.get(k) }) : ev);
          }
        } else if (ev.name === "IntentSet") {
          for (const o of origin.values()) {
            if (matched.has(o) || o.name !== "Intend" || o.chainId !== ev.originChainId) continue;
            if (o.token === ev.token && o.to === ev.to) {
              matched.add(o);
              verdictOf.set(o, ev);
              break;
            }
          }
        }
      }

      // Latency per trip.
      const tripList = [...trips.values()].sort((a, b) => a.tripId - b.tripId);
      for (const trip of tripList) {
        const o = trip.origin;
        const r = trip.reactive;
        const approx = (x) => !(x && x.tsExact);
        trip.latency = {
          toReactive: o && r && o.ts != null && r.ts != null ? r.ts - o.ts : null,
          toReactiveApprox: approx(o) || approx(r),
          sweeps: {},
        };
        let last = null;
        for (const s of Object.values(trip.sweeps)) {
          const ms = o && o.ts != null && s.ts != null ? s.ts - o.ts : null;
          trip.latency.sweeps[s.chainId] = { fromOrigin: ms, fromReactive: r && r.ts != null && s.ts != null ? s.ts - r.ts : null, approx: approx(o) || approx(s) };
          if (ms != null && (last == null || ms > last)) last = ms;
        }
        trip.latency.allSwept = trip.requests.length > 0 && trip.requests.every((q) => trip.sweeps[q.chainId] && trip.sweeps[q.chainId].done) ? last : null;
        trip.totalSwept = Object.values(trip.sweeps).reduce((n, s) => n + s.swept.length, 0);
        trip.status = !trip.reactive ? "pending" : trip.latency.allSwept != null ? "swept" : "sweeping";
      }

      // Activity feed: one row per meaningful event, newest first.
      const feed = [];
      for (const ev of evs) {
        const row = describe(ctx, ev, { verdictOf, sweepTxs });
        if (row) feed.push(row);
      }
      feed.reverse();
      return { trips: tripList, feed, events: evs };
    }
  }

  function cmpEvents(a, b) {
    const ta = a.ts ?? Infinity;
    const tb = b.ts ?? Infinity;
    if (ta !== tb) return ta - tb;
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  }

  const VERDICT_TEXT = {
    Trusted: "cleared: trusted recipient",
    UnderThreshold: "cleared: under threshold",
    Intended: "cleared: pre-cleared by an intent",
    Tripped: "TRIPPED",
    Merged: "merged into the latest trip: no new sweep",
    Ignored: "ignored",
  };

  /** One feed row, or null for events folded into others (Observed, Swept, sweep transfers...). */
  function describe(ctx, ev, { verdictOf, sweepTxs }) {
    const base = { ts: ev.ts, tsExact: ev.tsExact, chainId: ev.chainId, txHash: ev.txHash, kind: "origin", event: ev.name };
    const v = verdictOf.get(ev);
    const verdict = !v
      ? null
      : v.name === "IntentSet"
        ? "intent stored on Reactive"
        : v.mergedInto != null
          ? `merged into trip #${v.mergedInto}: no new sweep`
          : VERDICT_TEXT[v.verdict];
    const tripped = v && (v.verdict === "Tripped" || v.verdict === "Merged"); // merged: would have tripped
    switch (ev.name) {
      case "Transfer":
        if (ev.from !== ctx.hot) return null;
        if (sweepTxs.has(ev.chainId + ":" + ev.txHash)) return null; // shown with the sweep
        return { ...base, kind: tripped ? "alarm" : "origin", text: `${amountStr(ctx, ev.chainId, ev.token, ev.value)} sent from HOT to ${label(ctx, ev.to)}`, verdict, tripped };
      case "Approval":
        if (ev.owner !== ctx.hot) return null;
        return { ...base, kind: tripped ? "alarm" : "origin", text: `HOT approved ${label(ctx, ev.spender)} for ${amountStr(ctx, ev.chainId, ev.token, ev.value)}`, verdict, tripped };
      case "Intend":
        if (ev.owner !== ctx.cosigner) return null;
        return { ...base, text: `cosigner pre-cleared ${amountStr(ctx, ev.chainId, ev.token, ev.amount)} to ${label(ctx, ev.to)}`, verdict };
      case "Panic":
        return { ...base, kind: "alarm", text: `PANIC pressed by ${label(ctx, ev.caller)}`, verdict, tripped };
      case "Drained":
        return { ...base, kind: "alarm", text: `drainer pulled ${amountStr(ctx, ev.chainId, ev.token, ev.amount)} from ${label(ctx, ev.victim)}` };
      case "Tripped":
        return { ...base, kind: "trip", text: `Trip #${ev.tripId} (${ev.reason}) on Reactive: sweep requested on every chain` };
      case "SweepDone":
        return { ...base, kind: "sweep", text: `Guardian swept ${ev.swept} token${ev.swept === 1 ? "" : "s"} to the vault (trip #${ev.tripId}${ev.skipped ? `, ${ev.skipped} skipped` : ""}${ev.unhandled ? `, ${ev.unhandled} not reached` : ""})` };
      case "Replayed":
        return { ...base, kind: "sweep", text: `Guardian ignored a replay of trip #${ev.tripId}` };
      case "Duplicate":
        return { ...base, kind: "reactive", text: `Reactive skipped a duplicate log` };
      default:
        return null;
    }
  }

  /** Mock mode: balances from initial balances plus every Transfer seen so far. */
  function foldBalances(ctx, initial, events) {
    const out = {};
    for (const [id, toks] of Object.entries(initial || {})) {
      out[id] = {};
      for (const [tok, b] of Object.entries(toks)) out[id][norm(tok)] = { hot: BigInt(b.hot), cold: BigInt(b.cold) };
    }
    for (const ev of events) {
      if (ev.name !== "Transfer") continue;
      const row = (out[ev.chainId] || {})[ev.token];
      if (!row) continue;
      if (ev.from === ctx.hot) row.hot -= ev.value;
      if (ev.to === ctx.hot) row.hot += ev.value;
      if (ev.from === ctx.cold) row.cold -= ev.value;
      if (ev.to === ctx.cold) row.cold += ev.value;
    }
    return out;
  }

  // ------------------------------------------------------------------ polling ranges

  /**
   * Recognises the error a load-balanced RPC gives when eth_getLogs (or a block read) reaches a node that is behind
   * the one that answered eth_blockNumber: "block range extends beyond current head block[: requested N, head M]"
   * (op-geth behind proxyd, publicnode), "requested toBlock N is not yet available on the node (latestBlock: M, …)"
   * (Reactive), "header not found", "block not found". Returns { head } (null when the message names no head) or null.
   */
  function headError(msg) {
    const s = String(msg || "");
    if (!/beyond (the )?current head|not yet available|header not found|block not found|unknown block/i.test(s)) return null;
    const m = s.match(/\b(?:head|latestBlock):?\s+(\d+)/i);
    return { head: m ? Number(m[1]) : null };
  }

  const MAX_HEAD_LAG = 64;
  /**
   * How many blocks below the reported head to read from after a 'beyond head' error: exactly as far as the node that
   * served the logs said it was behind, or double the last lag when it didn't say. Capped, so a node that is
   * permanently a few blocks behind costs a few seconds of delay, never a stuck poller.
   */
  function learnHeadLag(lag, latest, err) {
    if (err && err.head != null && err.head < latest) return Math.min(MAX_HEAD_LAG, Math.max(lag + 1, latest - err.head));
    return Math.min(MAX_HEAD_LAG, Math.max(1, lag * 2));
  }

  /**
   * The next eth_getLogs range for a poller whose last read block is `cursor`, clamped to the head the same RPC just
   * reported (minus the learned lag) and to the RPC's range cap. null when there is nothing new to read yet.
   */
  function nextRange(cursor, latest, { maxRange = 1000, lag = 0 } = {}) {
    const head = latest - lag;
    const from = cursor + 1;
    if (from > head) return null;
    return { from, to: Math.min(head, from + maxRange - 1) };
  }

  /** History on load: scan the reactive contract's logs chunk by chunk when that's cheap, else bisect trips(). */
  function historyPlan(fromBlock, head, maxRange = 1000, maxChunks = 40) {
    if (fromBlock == null || fromBlock > head) return { mode: "bisect" };
    const chunks = Math.ceil((head - fromBlock + 1) / maxRange);
    if (chunks > maxChunks) return { mode: "bisect", chunks };
    const ranges = [];
    for (let f = fromBlock; f <= head; f += maxRange) ranges.push({ from: f, to: Math.min(head, f + maxRange - 1) });
    return { mode: "scan", ranges };
  }

  /** Smallest block b in [lo, hi] with pred(b) true (pred is monotonic and true at hi). */
  async function bisectFirst(lo, hi, pred) {
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (await pred(mid)) hi = mid;
      else lo = mid + 1;
    }
    return hi;
  }

  /** Runs at most n jobs at once (history load is staggered per RPC so it never floods a public endpoint). */
  function limiter(n) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= n || !queue.length) return;
      active++;
      const { fn, res, rej } = queue.shift();
      Promise.resolve()
        .then(fn)
        .then(res, rej)
        .finally(() => {
          active--;
          next();
        });
    };
    return (fn) => new Promise((res, rej) => (queue.push({ fn, res, rej }), next()));
  }

  /**
   * Loads a deployment's past trips into `monitor`, so the page shows real history, not only the last few minutes.
   *  1. TripwireReactive's own logs on Reactive: every chunk since `fromBlock` when that's at most `scanChunks`
   *     eth_getLogs calls, otherwise the block of each of the `recent` newest trips, found by bisecting the trips()
   *     counter over historical state (about log2(blocks) eth_calls per trip);
   *  2. for the `recent` newest trips: the Reactive block's time, the origin receipt, and each Guardian's sweep,
   *     looked up in the destination chain's blocks from 20 s before the trip (block found from the timestamp).
   * Every RPC goes through a per-chain limiter with one retry; a failed step leaves that trip partly filled, never
   * throws. Calls `onTrips({ detailed, compact, total })` synchronously right after the Reactive logs are in, and
   * `onProgress()` as trips fill in. Returns { total, detailed, compact, missing: Set("trip:chain"), calls }.
   *
   * o: { rpc(chainId, method, params), ctx, monitor, nets: { [chainId]: { maxRange, blockMs } }, fromBlock,
   *      recent = 5, scanChunks = 40, concurrency = 3, sweepWindows = 2, originFetched: Set, onTrips, onProgress }
   */
  async function loadHistory(o) {
    const { ctx, monitor } = o;
    const L = ctx.lasnaChainId;
    const recent = o.recent ?? 5;
    const nets = o.nets || {};
    const out = { total: 0, detailed: [], compact: [], missing: new Set(), calls: 0, mode: null };
    const lims = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const rpc = (id, method, params) =>
      (lims[id] ??= limiter(o.concurrency ?? 3))(async () => {
        for (let attempt = 0; ; attempt++) {
          out.calls++;
          try {
            return await o.rpc(id, method, params);
          } catch (e) {
            if (attempt >= 1) throw e;
            await sleep(o.retryMs ?? 800);
          }
        }
      });
    const hex = (n) => "0x" + n.toString(16);
    const range = (id) => (nets[id] || {}).maxRange || 1000;
    const blockMs = (id) => (nets[id] || {}).blockMs || 1000;

    const times = new Map(); // "chain:block" -> Promise<{ ms, exact } | null>
    const timeOf = (b) => (b.timestampMs != null ? { ms: toNum(b.timestampMs), exact: true } : { ms: toNum(b.timestamp) * 1000, exact: false });
    function blockTime(id, n) {
      const k = id + ":" + n;
      if (!times.has(k)) times.set(k, rpc(id, "eth_getBlockByNumber", [hex(n), false]).then((b) => (b ? timeOf(b) : null), () => null));
      return times.get(k);
    }
    async function stamp(id, n) {
      const t = await blockTime(id, n);
      if (t) monitor.setTimestamp(id, n, t.ms, t.exact);
      return t;
    }
    const heads = {};
    function headOf(id) {
      return (heads[id] ??= rpc(id, "eth_getBlockByNumber", ["latest", false]).then((b) => {
        const t = timeOf(b);
        times.set(id + ":" + toNum(b.number), Promise.resolve(t));
        return { n: toNum(b.number), ms: t.ms };
      }));
    }
    /** The block at (or just before) time `target`, from the chain's head and block time, refined on real blocks. */
    async function blockAt(id, target) {
      const ref = await headOf(id);
      const bms = blockMs(id);
      let b = Math.min(ref.n, Math.max(0, ref.n + Math.round((target - ref.ms) / bms)));
      for (let i = 0; i < 4; i++) {
        const t = await blockTime(id, b);
        if (!t) return b;
        const d = target - t.ms;
        if (Math.abs(d) <= Math.max(2 * bms, 2000)) return b;
        b = Math.min(ref.n, Math.max(0, b + Math.round(d / bms)));
      }
      return b;
    }

    // 1. The reactive contract's logs.
    const head = toNum(await rpc(L, "eth_blockNumber", []));
    const tripsAt = async (b) => {
      const r = await rpc(L, "eth_call", [{ to: ctx.tripwire, data: SELECTOR.trips }, hex(b)]);
      return r && r !== "0x" ? toNum(r) : 0; // "0x": before the contract existed
    };
    out.total = await tripsAt(head);
    if (!out.total) {
      if (o.onTrips) o.onTrips(out);
      return out;
    }
    const plan = historyPlan(o.fromBlock, head, range(L), o.scanChunks ?? 40);
    out.mode = plan.mode;
    const ingest = (id, logs) => monitor.ingest(logs.map((l) => ({ ...l, chainId: id, blockTimestampMs: null })));
    if (plan.mode === "scan") {
      const results = await Promise.all(plan.ranges.map((r) => rpc(L, "eth_getLogs", [{ address: ctx.tripwire, fromBlock: hex(r.from), toBlock: hex(r.to) }])));
      ingest(L, results.flat());
    } else {
      let hi = head;
      const lo = o.fromBlock ?? 0;
      for (let k = out.total; k >= Math.max(1, out.total - recent + 1); k--) {
        const b = await bisectFirst(lo, hi, async (x) => (await tripsAt(x)) >= k);
        ingest(L, await rpc(L, "eth_getLogs", [{ address: ctx.tripwire, fromBlock: hex(b), toBlock: hex(b) }]));
        hi = b;
      }
    }
    const trips = monitor.view().trips.filter((t) => t.reactive);
    const ids = trips.map((t) => t.tripId).sort((a, b) => b - a);
    out.detailed = ids.slice(0, recent);
    out.compact = ids.slice(recent);
    if (o.onTrips) o.onTrips(out); // synchronously after the ingest, before anything else can read the trips

    // 2. The newest trips: Reactive time, origin, sweeps.
    const T = TOPIC;
    async function sweepOf(trip, q) {
      const c = ctx.chains[q.chainId];
      if (!c || !c.guardian || !nets[q.chainId]) return;
      const r = await stamp(L, trip.reactive.blockNumber);
      if (!r) throw new Error("no Reactive block time");
      const start = await blockAt(q.chainId, r.ms - 20000);
      const ref = await headOf(q.chainId);
      const top = ref.n - 8; // below the head: a load-balanced RPC's other nodes may not have the newest blocks
      for (let w = 0; w < (o.sweepWindows ?? 2); w++) {
        const from = start + w * range(q.chainId);
        const to = Math.min(top, from + range(q.chainId) - 1);
        if (from > to) break;
        const logs = await rpc(q.chainId, "eth_getLogs", [
          { address: c.guardian, topics: [[T.Swept, T.Skipped, T.SweepDone, T.Replayed], numTopic(trip.tripId)], fromBlock: hex(from), toBlock: hex(to) },
        ]);
        if (!logs.length) continue;
        ingest(q.chainId, logs);
        await Promise.all([...new Set(logs.map((l) => toNum(l.blockNumber)))].map((n) => stamp(q.chainId, n)));
        if (logs.some((l) => norm(l.topics[0]) === T.SweepDone || norm(l.topics[0]) === T.Replayed)) return true;
      }
      return false;
    }
    async function originOf(trip) {
      const ref = trip.originRef;
      if (!ref || !ref.txHash || !nets[ref.chainId]) return;
      const k = ref.chainId + ":" + ref.txHash;
      if (o.originFetched) {
        if (o.originFetched.has(k)) return;
        o.originFetched.add(k);
      }
      const rc = await rpc(ref.chainId, "eth_getTransactionReceipt", [ref.txHash]);
      if (!rc) return;
      ingest(ref.chainId, rc.logs);
      await stamp(ref.chainId, toNum(rc.blockNumber));
    }
    await Promise.all(
      trips
        .filter((t) => out.detailed.includes(t.tripId))
        .map(async (trip) => {
          const jobs = [originOf(trip).catch(() => {})];
          for (const q of trip.requests)
            jobs.push(
              sweepOf(trip, q)
                .then((found) => found === false && out.missing.add(trip.tripId + ":" + q.chainId))
                .catch(() => out.missing.add(trip.tripId + ":" + q.chainId)),
            );
          await Promise.all(jobs);
          if (o.onProgress) o.onProgress(out);
        }),
    );
    return out;
  }

  return {
    SIGNATURES,
    TOPIC,
    TOPIC_NAME,
    SELECTOR,
    SELECTOR_SIGNATURES,
    REASON,
    VERDICT,
    SKIP_REASON,
    REACTIVE_SYSTEM,
    norm,
    toBig,
    toNum,
    wordAddr,
    encodeCall,
    addrTopic,
    numTopic,
    decodeUintArray,
    decodeChainConfig,
    decodeString,
    formatUnits,
    formatMs,
    short,
    label,
    tokenMeta,
    amountStr,
    makeContext,
    decodeLog,
    foldBalances,
    Monitor,
    MAX_HEAD_LAG,
    headError,
    learnHeadLag,
    nextRange,
    historyPlan,
    bisectFirst,
    limiter,
    loadHistory,
  };
});
