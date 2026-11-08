// Tripwire demo page: live poller (public RPCs) and mock replay (fixture.json). Rendering only; decoding and the
// timeline model live in core.js.
(function () {
  "use strict";
  const C = window.TripwireCore;
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // Used when config.json can't be fetched (e.g. the page was opened from file://).
  const DEFAULT_NETWORKS = {
    5318007: { name: "Reactive Lasna", short: "Lasna", rpc: "https://lasna-rpc.rnk.dev/", explorer: "https://lasna.reactscan.net", blockMs: 1065, maxRange: 1000, color: "#2bd4a4" },
    84532: { name: "Base Sepolia", short: "Base", rpc: "https://sepolia.base.org", explorer: "https://sepolia.basescan.org", callbackProxy: "0x476F44b11F5C942c58f4c8E3d0300E5710743585", blockMs: 200, maxRange: 200, color: "#4c8dff" },
    11155111: { name: "Ethereum Sepolia", short: "Ethereum", rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io", callbackProxy: "0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4", blockMs: 12000, maxRange: 1000, color: "#a6a9ff" },
    1301: { name: "Unichain Sepolia", short: "Unichain", rpc: "https://sepolia.unichain.org", explorer: "https://sepolia.uniscan.xyz", callbackProxy: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1", blockMs: 1000, maxRange: 1000, color: "#f05bd0" },
    // Mainnet (?net=mainnet loads config.mainnet.json, which repeats these)
    1597: { name: "Reactive Mainnet", short: "Reactive", rpc: "https://mainnet-rpc.rnk.dev/", explorer: "https://reactscan.net", blockMs: 786, maxRange: 1000, color: "#2bd4a4" },
    8453: { name: "Base", short: "Base", rpc: "https://base-rpc.publicnode.com", explorer: "https://basescan.org", callbackProxy: "0xCc780DdE33f56f55dE778D42c930959374a4a068", blockMs: 200, maxRange: 1000, color: "#4c8dff" },
    1: { name: "Ethereum", short: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io", callbackProxy: "0xFCE1F192F489c988392aBC16E91e359d540d94Fe", blockMs: 12000, maxRange: 1000, color: "#a6a9ff" },
    130: { name: "Unichain", short: "Unichain", rpc: "https://mainnet.unichain.org", explorer: "https://uniscan.xyz", callbackProxy: "0x754120EC7a6eF81E4c5c835AA603C63Da64693E6", blockMs: 1000, maxRange: 1000, color: "#f05bd0" },
  };

  const S = {
    mode: params.get("mock") === "1" ? "mock" : "live",
    cfg: null,
    nets: DEFAULT_NETWORKS,
    ctx: null,
    monitor: null,
    chainIds: [], // protected chains, in display order
    status: {}, // chainId -> { ok, text }
    balances: {}, // chainId -> token -> { hot, cold, allowance }
    health: {},
    fixture: null,
    replay: null,
    showRaw: false,
    error: null,
  };

  // ------------------------------------------------------------------ helpers

  const net = (id) => S.nets[id] || { name: "chain " + id, short: String(id), color: "#888" };
  const txUrl = (id, h) => (net(id).explorer ? `${net(id).explorer}/tx/${h}` : null);
  const addrUrl = (id, a) => (net(id).explorer ? `${net(id).explorer}/address/${a}` : null);
  const link = (url, text, title) => (url && S.mode === "live" ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(title || "")}">${esc(text)}</a>` : `<span class="mono" title="${esc(title || "")}">${esc(text)}</span>`);
  const txLink = (id, h) => (h ? link(txUrl(id, h), C.short(h), h) : "");
  const addrLink = (id, a) => (a ? link(addrUrl(id, a), C.short(a), a) : "–");
  const chip = (id) => `<span class="chip" style="--c:${esc(net(id).color)}">${esc(net(id).short)}</span>`;
  function clock(ms) {
    if (ms == null) return "time pending";
    const d = new Date(ms);
    return d.toISOString().slice(11, 23) + " UTC";
  }

  async function fetchJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  let rpcId = 0;
  async function rpc(chainId, method, params_) {
    const url = net(chainId).rpc;
    if (!url) throw new Error(`no RPC for chain ${chainId}`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params: params_ }),
        signal: ctl.signal,
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.result;
    } catch (e) {
      throw new Error(e.name === "AbortError" ? `${method}: timeout` : `${method}: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  const call = (chainId, to, data) => rpc(chainId, "eth_call", [{ to, data }, "latest"]);

  // ------------------------------------------------------------------ boot

  async function boot() {
    try {
      S.cfg = await fetchJson(params.get("config") || (params.get("net") === "mainnet" ? "config.mainnet.json" : "config.json"));
    } catch (e) {
      S.cfg = {};
      console.warn("config.json not loaded, using defaults:", e.message);
    }
    if (S.cfg.networks) S.nets = Object.assign({}, DEFAULT_NETWORKS, S.cfg.networks);
    if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";
    render();
    if (S.mode === "mock") await bootMock();
    else await bootLive();
  }

  // ------------------------------------------------------------------ mock replay

  async function bootMock() {
    try {
      S.fixture = await fetchJson(params.get("fixture") || "fixture.json");
    } catch (e) {
      S.error = "Could not load the fixture: " + e.message + ". Serve the demo folder over http (python3 -m http.server).";
      return render();
    }
    const f = S.fixture;
    S.ctx = C.makeContext(f.config);
    S.chainIds = Object.keys(f.config.chains).map(Number).sort(chainOrder);
    for (const id of [S.ctx.lasnaChainId, ...S.chainIds]) S.status[id] = { ok: true, text: "replay" };
    startReplay();
  }

  function startReplay() {
    const f = S.fixture;
    S.monitor = new C.Monitor(S.ctx);
    const logs = [...f.logs].sort((a, b) => a.blockTimestampMs - b.blockTimestampMs);
    const speed = Math.max(0.1, Number(params.get("speed") || 1));
    const start = logs[0].blockTimestampMs - 2000;
    const end = logs[logs.length - 1].blockTimestampMs;
    S.replay = { logs, i: 0, start, end, now: start, speed, wall: performance.now(), done: false };
    if (params.get("instant") === "1") {
      S.replay.now = end;
      stepReplay();
      return;
    }
    clearInterval(S.replay.timer);
    S.replay.timer = setInterval(stepReplay, 100);
    stepReplay();
  }

  function stepReplay() {
    const R = S.replay;
    if (params.get("instant") !== "1") R.now = R.start + (performance.now() - R.wall) * R.speed;
    const batch = [];
    while (R.i < R.logs.length && R.logs[R.i].blockTimestampMs <= R.now) batch.push(R.logs[R.i++]);
    if (batch.length) S.monitor.ingest(batch);
    S.balances = {};
    const folded = C.foldBalances(S.ctx, S.fixture.initialBalances, S.monitor.events);
    for (const [id, toks] of Object.entries(folded)) {
      S.balances[id] = {};
      for (const [t, b] of Object.entries(toks)) S.balances[id][t] = { hot: b.hot, cold: b.cold, allowance: null };
    }
    if (R.i >= R.logs.length) {
      R.done = true;
      clearInterval(R.timer);
    }
    // Redraw on new events, and a few times a second for the clock.
    const wall = performance.now();
    if (batch.length || R.done || wall - (R.drawn || 0) > 250) {
      R.drawn = wall;
      render();
    }
  }

  // ------------------------------------------------------------------ live mode

  async function bootLive() {
    const cfg = S.cfg;
    const lasna = Number(cfg.lasnaChainId || 5318007);
    const tripwire = params.get("tripwire") || cfg.tripwire;
    const fb = cfg.fallback || {};
    let hot = params.get("hot") || fb.hot;
    let cold = params.get("cold") || fb.cold;
    let cosigner = params.get("cosigner") || fb.cosigner;
    let chains = fb.chains || {};
    if (!tripwire) {
      S.error = "No Tripwire address yet. Put the TripwireReactive address in demo/config.json (config.mainnet.json with ?net=mainnet) or add ?tripwire=0x… to the URL. To see the page with recorded data, open ?mock=1.";
      return render();
    }
    S.status[lasna] = { ok: true, text: "reading config" };
    render();
    try {
      // eth_call to an address without code "succeeds" with empty data, so check the code first.
      const code = await rpc(lasna, "eth_getCode", [tripwire, "latest"]);
      if (!code || code === "0x") throw new Error(`no contract at this address on ${net(lasna).name}`);
      const word = async (sel) => C.wordAddr(await call(lasna, tripwire, sel));
      [hot, cold, cosigner] = await Promise.all([word(C.SELECTOR.HOT), word(C.SELECTOR.COLD), word(C.SELECTOR.COSIGNER)]);
      if (/^0x0{40}$/.test(hot)) throw new Error("HOT() returned nothing: is this a TripwireReactive?");
      const ids = C.decodeUintArray(await call(lasna, tripwire, C.SELECTOR.chainIds)).map(Number);
      chains = {};
      for (const id of ids) {
        const cc = C.decodeChainConfig(await call(lasna, tripwire, C.encodeCall(C.SELECTOR.chainConfig, id)));
        chains[id] = { guardian: cc.guardian, intent: cc.intent, panic: cc.panic, tokens: cc.tokens.map((a) => ({ address: a })) };
      }
      S.status[lasna] = { ok: true, text: "config read" };
    } catch (e) {
      S.status[lasna] = { ok: false, text: "config read failed: " + e.message };
      if (!hot || !Object.keys(chains).length) {
        S.error = `Could not read TripwireReactive ${tripwire} on ${net(lasna).name} (${e.message}), and config.json has no fallback.`;
        return render();
      }
    }
    // Token symbols and decimals, read from each token (USDC has 6, the demo tokens 6 or 18). The two reads are
    // independent, so a token without symbol() still gets its decimals; a config value is kept if a read fails.
    for (const c of Object.values(chains)) c.tokens = (c.tokens || []).map((t) => (typeof t === "string" ? { address: t } : t));
    await Promise.all(
      Object.entries(chains).flatMap(([id, c]) =>
        c.tokens.map(async (t) => {
          const [sym, dec] = await Promise.allSettled([call(Number(id), t.address, C.SELECTOR.symbol), call(Number(id), t.address, C.SELECTOR.decimals)]);
          const symbol = sym.status === "fulfilled" ? C.decodeString(sym.value) : "";
          const decimals = dec.status === "fulfilled" && dec.value && dec.value !== "0x" ? Number(C.toBig(dec.value)) : null;
          t.symbol = symbol || t.symbol || C.short(t.address);
          if (decimals != null && decimals <= 77) t.decimals = decimals;
          else {
            t.decimals ??= 18;
            console.warn(`decimals() unreadable for ${t.address} on ${id}; showing amounts with ${t.decimals} decimals`);
          }
        }),
      ),
    );
    S.ctx = C.makeContext({ lasnaChainId: lasna, tripwire, hot, cold, cosigner, chains, labels: cfg.labels || {} });
    S.monitor = new C.Monitor(S.ctx);
    S.chainIds = Object.keys(chains).map(Number).sort(chainOrder);
    S.cursor = {};
    S.blockTs = {};
    S.lookbackMin = Number(params.get("lookback") || cfg.lookbackMinutes || 10);
    S.pollMs = Number(params.get("poll") || cfg.pollMs || 4000);
    S.balanceEvery = Number(cfg.balanceEveryMs || 8000);
    S.lastBalances = 0;
    S.originFetched = new Set();
    render();
    loop();
  }

  async function loop() {
    const t0 = performance.now();
    const ids = [S.ctx.lasnaChainId, ...S.chainIds];
    await Promise.all(ids.map((id) => pollChain(id).catch((e) => (S.status[id] = { ok: false, text: e.message }))));
    await fillTimestamps().catch((e) => console.warn(e));
    await fetchMissingOrigins().catch((e) => console.warn(e));
    if (performance.now() - S.lastBalances > S.balanceEvery || S.newEvents) {
      S.lastBalances = performance.now();
      S.newEvents = false;
      await refreshBalances().catch((e) => console.warn(e));
    }
    render();
    setTimeout(loop, Math.max(500, S.pollMs - (performance.now() - t0)));
  }

  function logFilters(id) {
    const ctx = S.ctx;
    const T = C.TOPIC;
    if (id === ctx.lasnaChainId) return [{ address: ctx.tripwire }];
    const c = ctx.chains[id];
    const watched = [...c.tokens, c.intent, c.panic].filter((a) => a && !/^0x0{40}$/.test(a));
    const who = [C.addrTopic(ctx.hot), C.addrTopic(ctx.cosigner)];
    const f = [{ address: watched, topics: [[T.Transfer, T.Approval, T.Intend, T.Panic], who] }];
    if (c.guardian && !/^0x0{40}$/.test(c.guardian)) f.push({ address: c.guardian, topics: [[T.Swept, T.Skipped, T.SweepDone, T.Replayed]] });
    return f;
  }

  async function pollChain(id) {
    const n = net(id);
    const latest = C.toNum(await rpc(id, "eth_blockNumber", []));
    if (S.cursor[id] == null) S.cursor[id] = Math.max(0, latest - Math.ceil((S.lookbackMin * 60000) / (n.blockMs || 1000)));
    const range = n.maxRange || 1000;
    let chunks = 0;
    while (S.cursor[id] < latest && chunks++ < 25) {
      const from = S.cursor[id] + 1;
      const to = Math.min(latest, from + range - 1);
      const hex = (x) => "0x" + x.toString(16);
      const results = await Promise.all(logFilters(id).map((f) => rpc(id, "eth_getLogs", [{ ...f, fromBlock: hex(from), toBlock: hex(to) }])));
      const logs = results.flat().map((l) => {
        const hit = (S.blockTs[id] || {})[C.toNum(l.blockNumber)];
        return { ...l, chainId: id, blockTimestampMs: hit ? hit.ms : null, tsExact: hit ? hit.exact : false };
      });
      if (logs.length && S.monitor.ingest(logs)) S.newEvents = true;
      S.cursor[id] = to;
    }
    const behind = latest - S.cursor[id];
    S.status[id] = { ok: true, text: behind > 0 ? `catching up, ${behind} blocks behind` : `block ${latest}` };
  }

  async function fillTimestamps() {
    const need = new Map();
    for (const ev of S.monitor.events) if (ev.ts == null) need.set(ev.chainId + ":" + ev.blockNumber, [ev.chainId, ev.blockNumber]);
    await Promise.all(
      [...need.values()].slice(0, 40).map(async ([id, b]) => {
        const blk = await rpc(id, "eth_getBlockByNumber", ["0x" + b.toString(16), false]);
        if (!blk) return;
        const exact = blk.timestampMs != null;
        const ms = exact ? C.toNum(blk.timestampMs) : C.toNum(blk.timestamp) * 1000;
        (S.blockTs[id] ??= {})[b] = { ms, exact };
        S.monitor.setTimestamp(id, b, ms, exact);
      }),
    );
  }

  /** A trip whose origin log is older than the lookback window: fetch that one receipt. */
  async function fetchMissingOrigins() {
    for (const trip of S.monitor.view().trips) {
      if (trip.origin || !trip.originRef) continue;
      const k = trip.originRef.chainId + ":" + trip.originRef.txHash;
      if (S.originFetched.has(k) || !net(trip.originRef.chainId).rpc) continue;
      S.originFetched.add(k);
      const rc = await rpc(trip.originRef.chainId, "eth_getTransactionReceipt", [trip.originRef.txHash]);
      if (!rc) continue;
      S.monitor.ingest(rc.logs.map((l) => ({ ...l, chainId: trip.originRef.chainId, blockTimestampMs: null })));
    }
  }

  async function refreshBalances() {
    const ctx = S.ctx;
    const jobs = [];
    for (const id of S.chainIds) {
      const c = ctx.chains[id];
      S.balances[id] ??= {};
      for (const t of c.tokens) {
        jobs.push(
          (async () => {
            const [h, k, a] = await Promise.all([
              call(id, t, C.encodeCall(C.SELECTOR.balanceOf, ctx.hot)),
              call(id, t, C.encodeCall(C.SELECTOR.balanceOf, ctx.cold)),
              c.guardian ? call(id, t, C.encodeCall(C.SELECTOR.allowance, ctx.hot, c.guardian)) : "0x0",
            ]);
            S.balances[id][t] = { hot: C.toBig(h), cold: C.toBig(k), allowance: C.toBig(a) };
          })().catch((e) => console.warn("balance", id, t, e.message)),
        );
      }
      const proxy = net(id).callbackProxy;
      if (proxy && c.guardian) {
        jobs.push(
          call(id, proxy, C.encodeCall(C.SELECTOR.debt, c.guardian))
            .then((d) => ((S.health[id] ??= {}).debt = C.toBig(d)))
            .catch(() => {}),
        );
      }
    }
    const L = ctx.lasnaChainId;
    jobs.push(
      rpc(L, "eth_getBalance", [ctx.tripwire, "latest"]).then((b) => ((S.health[L] ??= {}).balance = C.toBig(b))).catch(() => {}),
      call(L, C.REACTIVE_SYSTEM, C.encodeCall(C.SELECTOR.debt, ctx.tripwire)).then((d) => ((S.health[L] ??= {}).debt = C.toBig(d))).catch(() => {}),
      call(L, C.REACTIVE_SYSTEM, C.encodeCall(C.SELECTOR.reserves, ctx.tripwire)).then((r) => ((S.health[L] ??= {}).reserve = C.toBig(r))).catch(() => {}),
    );
    await Promise.all(jobs);
  }

  function chainOrder(a, b) {
    const order = [84532, 8453, 11155111, 1, 1301, 130]; // Base, Ethereum, Unichain (testnet, mainnet)
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a - b;
  }

  // ------------------------------------------------------------------ rendering

  function render() {
    renderHeader();
    if (S.error) {
      $("main").innerHTML = `<section class="panel notice">${esc(S.error)}</section>`;
      return;
    }
    if (!S.monitor) {
      $("main").innerHTML = `<section class="panel notice">Loading…</section>`;
      return;
    }
    const v = S.monitor.view();
    $("main").innerHTML = [renderWatch(), renderBalances(), renderTrips(v), renderLatency(v), renderFeed(v)].join("");
    const raw = $("raw-toggle");
    if (raw) raw.onchange = (e) => ((S.showRaw = e.target.checked), render());
    const again = $("replay-again");
    if (again) again.onclick = () => startReplay();
  }

  function renderHeader() {
    const mock = S.mode === "mock";
    let right = "";
    if (mock && S.replay) {
      const R = S.replay;
      right = `<span class="muted">replay ${esc(clock(R.now))} · ${R.speed}×</span>` + (R.done ? ` <button id="replay-again">Replay</button>` : "");
    } else if (!mock) {
      right = `<span class="muted">polling every ${((S.pollMs || 4000) / 1000).toFixed(0)} s · ${esc(clock(Date.now()))}</span>`;
    }
    $("header").innerHTML = `
      <div class="brand"><span class="logo">⟟</span> Tripwire <span class="sub">cross-chain drain guard · monitor</span></div>
      <div class="hdr-right"><span class="pill ${mock ? "pill-mock" : "pill-live"}">${mock ? "SIMULATED REPLAY" : "LIVE"}</span> ${right}</div>`;
    $("banner").innerHTML = mock && S.fixture ? `<div class="banner"><b>Simulated data.</b> ${esc(S.fixture.note)}</div>` : "";
    if (right.includes("replay-again")) $("replay-again").onclick = () => startReplay();
  }

  function renderWatch() {
    const ctx = S.ctx;
    const L = ctx.lasnaChainId;
    const h = S.health[L] || {};
    const statusDot = (id) => {
      const s = S.status[id] || { ok: true, text: "…" };
      return `<span class="dot ${s.ok ? "ok" : "bad"}" title="${esc(s.text)}"></span><span class="muted small">${esc(s.text)}</span>`;
    };
    const rows = S.chainIds
      .map((id) => {
        const c = ctx.chains[id];
        const debt = (S.health[id] || {}).debt;
        return `<tr><td>${chip(id)}</td><td>${addrLink(id, c.guardian)}</td><td>${c.tokens.length}</td>
          <td>${debt == null ? "–" : debt === 0n ? `<span class="ok-t">0</span>` : `<span class="bad-t">${esc(C.formatUnits(debt, 18, 6))} ETH</span>`}</td>
          <td>${statusDot(id)}</td></tr>`;
      })
      .join("");
    return `<section class="panel">
      <h2>What is guarded</h2>
      <div class="kv">
        <div><span class="k">Hot wallet</span>${addrLink(S.chainIds[0], ctx.hot)}</div>
        <div><span class="k">Vault (COLD)</span>${addrLink(S.chainIds[0], ctx.cold)}</div>
        <div><span class="k">Cosigner</span>${addrLink(S.chainIds[0], ctx.cosigner)}</div>
        <div><span class="k">TripwireReactive</span>${chip(L)} ${addrLink(L, ctx.tripwire)}
          ${h.balance != null ? `<span class="muted small">${esc(C.formatUnits(h.balance, 18, 3))} ${S.ctx.lasnaChainId === 1597 ? "REACT" : "lREACT"}${h.reserve ? ` + ${esc(C.formatUnits(h.reserve, 18, 3))} in reserve` : ""}${h.debt ? `, <span class="bad-t">debt ${esc(C.formatUnits(h.debt, 18, 4))}</span>` : ""}</span>` : ""}
          ${statusDot(L)}</div>
      </div>
      <table class="tbl"><thead><tr><th>Chain</th><th>Guardian</th><th>Tokens</th><th>Callback debt</th><th>RPC</th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
  }

  function renderBalances() {
    const ctx = S.ctx;
    let rows = "";
    for (const id of S.chainIds) {
      for (const t of ctx.chains[id].tokens) {
        const b = (S.balances[id] || {})[t];
        const m = C.tokenMeta(ctx, id, t);
        const hot = b ? b.hot : null;
        const cold = b ? b.cold : null;
        const total = hot != null && cold != null ? hot + cold : 0n;
        const pct = total > 0n ? Number((cold * 1000n) / total) / 10 : 0;
        let armed = `<span class="muted">n/a in replay</span>`;
        if (b && b.allowance != null) armed = b.allowance >= 1n << 128n ? `<span class="ok-t">armed</span>` : b.allowance === 0n ? `<span class="bad-t">not approved</span>` : `<span class="warn-t">${esc(C.formatUnits(b.allowance, m.decimals))}</span>`;
        rows += `<tr><td>${chip(id)}</td><td><b>${esc(m.symbol)}</b></td>
          <td class="num ${hot > 0n ? "" : "muted"}">${hot == null ? "…" : esc(C.formatUnits(hot, m.decimals, 2))}</td>
          <td class="num ${cold > 0n ? "ok-t" : "muted"}">${cold == null ? "…" : esc(C.formatUnits(cold, m.decimals, 2))}</td>
          <td class="bar-cell"><div class="bar"><div class="bar-v" style="width:${pct}%"></div></div><span class="small muted">${total > 0n ? pct.toFixed(0) + "% in vault" : ""}</span></td>
          <td>${armed}</td></tr>`;
      }
    }
    return `<section class="panel">
      <h2>Balances <span class="muted small">hot wallet vs vault${S.mode === "live" ? ", read every few seconds" : ", from the replayed transfers"}</span></h2>
      <table class="tbl"><thead><tr><th>Chain</th><th>Token</th><th class="num">Hot</th><th class="num">Vault</th><th>Share in vault</th><th>Guardian allowance</th></tr></thead><tbody>${rows}</tbody></table>
    </section>`;
  }

  function renderTrips(v) {
    if (!v.trips.length) {
      const nTok = S.chainIds.reduce((n, id) => n + S.ctx.chains[id].tokens.length, 0);
      return `<section class="panel"><h2>Trips</h2><p class="muted">No trip yet. Watching ${nTok} token${nTok === 1 ? "" : "s"} on ${S.chainIds.length} chain${S.chainIds.length === 1 ? "" : "s"}.</p></section>`;
    }
    const cards = [...v.trips]
      .reverse()
      .map((trip) => {
        const o = trip.origin;
        const ref = trip.originRef || {};
        const r = trip.reactive;
        const oText = o ? originText(o) : `origin tx ${C.short(ref.txHash || "")} (outside the window)`;
        // Landed sweeps in the order they landed, then the ones still pending.
        const landedAt = (q) => { const s = trip.sweeps[q.chainId]; return s && s.ts != null ? Number(s.ts) : Infinity; };
        const sweeps = [...trip.requests]
          .sort((a, b) => landedAt(a) - landedAt(b))
          .map((q) => {
            const s = trip.sweeps[q.chainId];
            const lat = trip.latency.sweeps[q.chainId];
            if (!s) return `<div class="sweep pending">${chip(q.chainId)} <span class="muted">waiting for callback (${q.tokens} tokens)…</span></div>`;
            const moved = s.swept.map((x) => esc(C.amountStr(S.ctx, q.chainId, x.token, x.amount))).join(", ") || "nothing left to move";
            const skipped = s.skipped.length ? ` <span class="warn-t">skipped ${s.skipped.map((x) => esc(C.tokenMeta(S.ctx, q.chainId, x.token).symbol + ": " + x.reason)).join(", ")}</span>` : "";
            return `<div class="sweep ${s.done ? "done" : ""}">${chip(q.chainId)}
              <span class="lat">${esc(C.formatMs(lat && lat.fromOrigin, lat && lat.approx))}</span>
              <span class="meta">${esc(clock(s.ts))} · ${txLink(q.chainId, s.txHash)}</span>
              <span class="what">${s.replayed ? "replay ignored" : "→ vault: " + moved}${skipped}</span></div>`;
          })
          .join("");
        const all = trip.latency.allSwept;
        return `<article class="trip trip-${trip.status}">
          <header><b>Trip #${trip.tripId}</b> <span class="pill pill-trip">${esc(trip.reason)}</span>
            <span class="muted">from ${esc(net(ref.chainId).name)}</span>
            <span class="pill ${trip.status === "swept" ? "pill-ok" : "pill-wait"}">${trip.status === "swept" ? "all chains swept" : "sweeping…"}</span></header>
          <div class="flow">
            <div class="step"><div class="step-h">1 · Origin ${chip(ref.chainId)}</div>
              <div class="step-b">${esc(oText)}</div>
              <div class="meta">${esc(clock(o && o.ts))} · ${txLink(ref.chainId, ref.txHash)}</div></div>
            <div class="arrow">→</div>
            <div class="step"><div class="step-h">2 · Reactive ${chip(r ? r.chainId : S.ctx.lasnaChainId)}</div>
              <div class="step-b">Tripped, ${trip.requests.length} sweep callback${trip.requests.length === 1 ? "" : "s"} requested
                <span class="lat">${esc(C.formatMs(trip.latency.toReactive, trip.latency.toReactiveApprox))}</span></div>
              <div class="meta">${esc(clock(r && r.ts))} · ${r ? txLink(r.chainId, r.txHash) : ""}</div></div>
            <div class="arrow">→</div>
            <div class="step wide"><div class="step-h">3 · Guardian sweeps</div>${sweeps || `<span class="muted">no Guardian configured</span>`}</div>
          </div>
          ${all != null ? `<footer>Every chain swept <b>${esc(C.formatMs(all, true).replace("+", ""))}</b> after the origin block.</footer>` : ""}
          ${trip.merged.length ? `<footer class="muted">${trip.merged.length} later move${trip.merged.length === 1 ? "" : "s"} merged into this trip, no new sweep: ${trip.merged.map((m) => `${esc(m.reason)} ${txLink(m.chainId, m.txHash)}`).join(", ")}</footer>` : ""}
        </article>`;
      })
      .join("");
    return `<section class="panel"><h2>Trips <span class="muted small">origin event → Reactive trip → callback sweep on every chain</span></h2>${cards}</section>`;
  }

  function originText(o) {
    const ctx = S.ctx;
    if (o.name === "Transfer") return `HOT sent ${C.amountStr(ctx, o.chainId, o.token, o.value)} to ${C.label(ctx, o.to)}`;
    if (o.name === "Approval") return `HOT approved ${C.label(ctx, o.spender)} for ${C.amountStr(ctx, o.chainId, o.token, o.value)}`;
    if (o.name === "Panic") return `Panic pressed by ${C.label(ctx, o.caller)}`;
    return o.name;
  }

  function renderLatency(v) {
    if (!v.trips.length) return "";
    const head = S.chainIds.map((id) => `<th class="num">→ sweep ${chip(id)}</th>`).join("");
    const rows = v.trips
      .map((t) => {
        const cells = S.chainIds
          .map((id) => {
            const l = t.latency.sweeps[id];
            return `<td class="num">${l ? esc(C.formatMs(l.fromOrigin, l.approx)) : "–"}</td>`;
          })
          .join("");
        return `<tr><td>#${t.tripId}</td><td>${esc(t.reason)}</td><td>${chip((t.originRef || {}).chainId)}</td>
          <td class="num">${esc(C.formatMs(t.latency.toReactive, t.latency.toReactiveApprox))}</td>${cells}
          <td class="num"><b>${esc(C.formatMs(t.latency.allSwept, true))}</b></td></tr>`;
      })
      .join("");
    return `<section class="panel"><h2>Latency <span class="muted small">from the origin block's timestamp; "≈" where a chain's blocks only carry whole seconds</span></h2>
      <table class="tbl"><thead><tr><th>Trip</th><th>Reason</th><th>Origin</th><th class="num">→ Reactive</th>${head}<th class="num">→ all swept</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  }

  function renderFeed(v) {
    const rows = v.feed
      .map(
        (r) => `<li class="row row-${r.kind}"><span class="t">${esc(clock(r.ts))}</span>${chip(r.chainId)}
          <span class="txt">${esc(r.text)}</span>${r.verdict ? `<span class="verdict ${r.tripped ? "v-trip" : "v-ok"}">${esc(r.verdict)}</span>` : ""}
          <span class="meta">${txLink(r.chainId, r.txHash)}</span></li>`,
      )
      .join("");
    const raw = S.showRaw
      ? `<pre class="raw">${esc(
          v.events
            .map((e) => {
              const { name, chainId, txHash, logIndex, ts, ...rest } = e;
              delete rest.address;
              delete rest.blockNumber;
              delete rest.tsExact;
              return `${clock(ts)}  ${net(chainId).short.padEnd(8)} ${name.padEnd(15)} ${C.short(txHash)}#${logIndex}  ${JSON.stringify(rest, (k, x) => (typeof x === "bigint" ? x.toString() : x))}`;
            })
            .join("\n"),
        )}</pre>`
      : "";
    return `<section class="panel"><h2>Activity <label class="small muted toggle"><input type="checkbox" id="raw-toggle" ${S.showRaw ? "checked" : ""}> all decoded events</label></h2>
      <ul class="feed">${rows || `<li class="muted">Nothing yet.</li>`}</ul>${raw}</section>`;
  }

  boot();
})();
