// Tripwire Arm: set up, check and manage a Tripwire guard from an injected wallet (window.ethereum).
// Static page, no build step. Reads every chain through the RPCs in the demo config (../config.json, or
// ?net=mainnet → ../config.mainnet.json, or ?config=<file in demo/>); the wallet only signs. ABIs and bytecode come
// from Foundry's out/ via tools/build-contracts.mjs (contracts.js).
import * as V from "https://cdn.jsdelivr.net/npm/viem@2.21.54/+esm";
import { CONTRACTS } from "./contracts.js";

// ------------------------------------------------------------------ constants

const TW = CONTRACTS.TripwireReactive.abi;
const GU = CONTRACTS.Guardian.abi;
const IN = CONTRACTS.Intent.abi;
const PB = CONTRACTS.PanicButton.abi;
const ERC20 = V.parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
// depositTo() exists on the system contract (Reactive Network) and on every callback proxy (script/Chains.sol).
const PAYEE = V.parseAbi([
  "function depositTo(address) payable",
  "function debt(address) view returns (uint256)",
  "function reserves(address) view returns (uint256)",
]);
const SYSTEM = "0x8888888888888888888888888888888888888888";
// Deterministic CREATE2 factory used by forge scripts; same salt as script/DeploySignals.s.sol.
const FACTORY = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const SALT = V.keccak256(V.stringToHex("apeir.tripwire.v1"));
const ZERO = V.zeroAddress;
const MAXU = V.maxUint256;
const FLOOR = 1n << 128n; // TripwireReactive.GUARDIAN_ALLOWANCE_FLOOR
const MAX_TTL_MIN = 24 * 60; // Intent.MAX_TTL
const REASON = ["Transfer", "Approval", "GuardianRevoked", "Panic"];
const REASON_TEXT = {
  Transfer: "an untrusted transfer from HOT",
  Approval: "an untrusted approval from HOT",
  GuardianRevoked: "the Guardian's approval being cut",
  Panic: "a panic press",
};
// Circle's USDC per chain (script/Chains.sol), offered as a suggestion when watching tokens.
const USDC = {
  84532: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  1301: "0x31d0220469e10c4E71834a79b1f276d740d3768F",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  130: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
};
const REACTIVE_IDS = [5318007, 1597];
const REACT_SYMBOL = { 5318007: "lREACT", 1597: "REACT" };

// ------------------------------------------------------------------ config

const Q = new URLSearchParams(location.search);
const NET_FILES = { testnet: "config.json", mainnet: "config.mainnet.json" };
const NET = Q.get("config") ? null : NET_FILES[Q.get("net")] ? Q.get("net") : "testnet";
const CFG_FILE = Q.get("config") || NET_FILES[NET];

const S = {
  cfg: null,
  rid: 0, // Reactive Network chain id of this config
  nets: {},
  mainnet: false,
  otherNets: [], // [net, label] the switcher offers
  twAddr: null,
  twSource: "",
  guard: null,
  guardErr: null,
  history: null,
  histErr: null,
  loading: false,
  account: null,
  walletChain: null,
  view: "manage",
  running: false,
  fastUntil: 0,
};

window.__tripwireArm = S; // for the console and the e2e test
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isAddr = (a) => typeof a === "string" && V.isAddress(a, { strict: false }) && BigInt(a) !== 0n;
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const short = (a) => (typeof a === "string" && /^0x[0-9a-fA-F]{40,64}$/.test(a) ? a.slice(0, 6) + "…" + a.slice(-4) : String(a ?? ""));
const andList = (xs) => (xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]);
const errText = (e) => e?.shortMessage || e?.details || e?.message || String(e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  key: (k) => `tripwire-arm:${S.rid}:${k}`,
  get(k, d = null) {
    try {
      const v = localStorage.getItem(this.key(k));
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      if (v == null) localStorage.removeItem(this.key(k));
      else localStorage.setItem(this.key(k), JSON.stringify(v));
    } catch {}
  },
};

async function loadConfig() {
  const r = await fetch("../" + CFG_FILE, { cache: "no-store" });
  if (!r.ok) throw new Error(`could not load ${CFG_FILE} (${r.status})`);
  const cfg = await r.json();
  S.cfg = cfg;
  S.nets = {};
  for (const [id, n] of Object.entries(cfg.networks || {})) S.nets[Number(id)] = { ...n, id: Number(id) };
  S.rid = Number(cfg.reactiveChainId || cfg.lasnaChainId || Object.keys(S.nets).map(Number).find((i) => REACTIVE_IDS.includes(i)));
  if (!S.nets[S.rid]) throw new Error(`${CFG_FILE} has no Reactive Network entry`);
  S.mainnet = S.rid === 1597;
  // Offer the other network set only if its config exists.
  if (NET) {
    const other = NET === "mainnet" ? "testnet" : "mainnet";
    const ok = await fetch("../" + NET_FILES[other], { method: "HEAD", cache: "no-store" }).then((x) => x.ok).catch(() => false);
    if (ok) S.otherNets = [[other, other === "mainnet" ? "Mainnet" : "Testnet"]];
  }
  // Which guard: ?tripwire= > the one this browser set up or opened last > the config's.
  const fromUrl = Q.get("tripwire");
  const saved = store.get("tripwire");
  if (isAddr(fromUrl)) [S.twAddr, S.twSource] = [V.getAddress(fromUrl), "link"];
  else if (isAddr(saved)) [S.twAddr, S.twSource] = [V.getAddress(saved), "saved"];
  else if (isAddr(cfg.tripwire)) [S.twAddr, S.twSource] = [V.getAddress(cfg.tripwire), "config"];
  if (!S.twAddr) S.view = "new";
}

const destIds = () => Object.keys(S.nets).map(Number).filter((id) => id !== S.rid && S.nets[id].callbackProxy);
const net = (id) => S.nets[id] || { name: `chain ${id}`, short: `chain ${id}`, color: "#8a97a6" };
const nativeSym = (id) => REACT_SYMBOL[id] || net(id).currency || "ETH";
const chip = (id) => `<span class="chip" style="--c:${esc(net(id).color || "#8a97a6")}">${esc(net(id).short || net(id).name)}</span>`;
function link(id, kind, v, label) {
  const ex = net(id).explorer;
  const text = esc(label || short(v));
  return ex ? `<a class="addr" href="${esc(ex)}/${kind}/${esc(v)}" target="_blank" rel="noopener" title="${esc(v)}">${text}</a>` : `<span class="addr" title="${esc(v)}">${text}</span>`;
}

const clients = {};
function pub(id) {
  const n = S.nets[id];
  if (!n?.rpc) throw new Error(`no RPC for chain ${id} in ${CFG_FILE}`);
  return (clients[id] ??= V.createPublicClient({ transport: V.http(n.rpc, { timeout: 25_000, retryCount: 1 }) }));
}

function fmt(v, dec = 18, max = 4) {
  if (v == null) return "–";
  v = BigInt(v);
  if (v >= FLOOR) return "unlimited";
  const s = V.formatUnits(v, dec);
  let [w, f = ""] = s.split(".");
  f = f.slice(0, max).replace(/0+$/, "");
  if (v > 0n && w === "0" && !f) return "<0." + "0".repeat(max - 1) + "1";
  return w.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
}
function ago(sec) {
  const d = Math.round(Date.now() / 1000 - Number(sec));
  if (d < 0) return "in " + dur(-d);
  return dur(d) + " ago";
}
function dur(s) {
  s = Number(s);
  if (s < 90) return s + " s";
  if (s < 5400) return Math.round(s / 60) + " min";
  if (s < 172800) return (s / 3600).toFixed(1).replace(/\.0$/, "") + " h";
  return Math.round(s / 86400) + " days";
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}
const signalAddr = (bytecode) => V.getContractAddress({ from: FACTORY, salt: SALT, bytecode, opcode: "CREATE2" });

// ------------------------------------------------------------------ reading a guard

async function loadGuard() {
  const rc = pub(S.rid);
  const a = S.twAddr;
  const code = await rc.getCode({ address: a });
  if (!code || code === "0x") {
    const e = new Error(`No contract at ${a} on ${net(S.rid).name}.`);
    e.notDeployed = true;
    throw e;
  }
  const r = (functionName, args = []) => rc.readContract({ address: a, abi: TW, functionName, args });
  const [hot, cold, cosigner, owner, trips, cooldown, lastTripAt, chainIds, balance] = await Promise.all([
    r("HOT"), r("COLD"), r("COSIGNER"), r("owner"), r("trips"), r("tripCooldown"), r("lastTripAt"), r("chainIds"),
    rc.getBalance({ address: a }),
  ]);
  const sysDebt = await rc.readContract({ address: SYSTEM, abi: PAYEE, functionName: "debt", args: [a] }).catch(() => null);
  const g = { address: a, hot, cold, cosigner, owner, trips, cooldown: Number(cooldown), lastTripAt: Number(lastTripAt), balance, sysDebt };
  g.chains = await Promise.all(chainIds.map((id) => loadChain(Number(id), g)));
  return g;
}

async function loadChain(id, g) {
  const rc = pub(S.rid);
  const cc = await rc.readContract({ address: g.address, abi: TW, functionName: "chainConfig", args: [BigInt(id)] });
  const ch = { id, guardian: cc.guardian, intent: cc.intent, panic: cc.panicButton, tokens: [], known: !!S.nets[id]?.rpc, issues: [] };
  const thresholds = await Promise.all(cc.tokens.map((t) => rc.readContract({ address: g.address, abi: TW, functionName: "threshold", args: [BigInt(id), t] })));
  ch.tokens = cc.tokens.map((address, i) => ({ address, threshold: thresholds[i], symbol: short(address), decimals: 18 }));
  if (!ch.known) return ch;
  const c = pub(id);
  const proxy = S.nets[id].callbackProxy;
  try {
    const hasG = ch.guardian !== ZERO;
    const [gCode, iCode, pCode] = await Promise.all([
      hasG ? c.getCode({ address: ch.guardian }) : null,
      ch.intent !== ZERO ? c.getCode({ address: ch.intent }) : null,
      ch.panic !== ZERO ? c.getCode({ address: ch.panic }) : null,
    ]);
    ch.intentOk = !!iCode && iCode !== "0x";
    ch.panicOk = !!pCode && pCode !== "0x";
    if (hasG) {
      if (!gCode || gCode === "0x") ch.issues.push(`No contract at the Guardian address ${short(ch.guardian)} on ${net(id).name}.`);
      else {
        const gr = (fn) => c.readContract({ address: ch.guardian, abi: GU, functionName: fn });
        const [gh, gc, gs, gp] = await Promise.all([gr("HOT"), gr("COLD"), gr("_CALLBACK_SENDER"), gr("_SERVICE_PROVIDER")]);
        if (!same(gh, g.hot) || !same(gc, g.cold)) ch.issues.push("The Guardian protects a different HOT/COLD pair than this Tripwire.");
        if (!same(gs, g.address)) ch.issues.push(`The Guardian only accepts callbacks from ${short(gs)}, not this Tripwire.`);
        if (proxy && !same(gp, proxy)) ch.issues.push(`The Guardian expects callback proxy ${short(gp)}, not ${short(proxy)}.`);
      }
      if (proxy) {
        const pr = (fn) => c.readContract({ address: proxy, abi: PAYEE, functionName: fn, args: [ch.guardian] }).catch(() => null);
        [ch.reserves, ch.debt] = await Promise.all([pr("reserves"), pr("debt")]);
      }
    }
    await Promise.all(ch.tokens.map(async (t) => {
      const tc = await c.getCode({ address: t.address });
      if (!tc || tc === "0x") {
        t.missing = true;
        return;
      }
      const tr = (fn, args = []) => c.readContract({ address: t.address, abi: ERC20, functionName: fn, args });
      const [sym, dec, bal, coldBal, allow] = await Promise.all([
        tr("symbol").catch(() => short(t.address)), tr("decimals").catch(() => 18), tr("balanceOf", [g.hot]), tr("balanceOf", [g.cold]),
        hasG ? tr("allowance", [g.hot, ch.guardian]) : 0n,
      ]);
      Object.assign(t, { symbol: sym, decimals: Number(dec), balance: bal, coldBalance: coldBal, allowance: allow, armed: hasG && allow >= FLOOR });
    }));
    // A Guardian this browser deployed but Tripwire doesn't point at yet, and old Guardians with approvals left.
    const pend = store.get(`pending:${g.address}:${id}`);
    if (!hasG && isAddr(pend)) ch.pending = pend;
    const retired = (store.get(`retired:${g.address}:${id}`) || []).filter((r) => !same(r, ch.guardian));
    ch.leftovers = [];
    await Promise.all(retired.map(async (old) => {
      for (const t of ch.tokens.filter((t) => !t.missing)) {
        const al = await c.readContract({ address: t.address, abi: ERC20, functionName: "allowance", args: [g.hot, old] }).catch(() => 0n);
        if (al > 0n) ch.leftovers.push({ guardian: old, token: t, allowance: al });
      }
    }));
  } catch (e) {
    ch.err = errText(e);
  }
  return ch;
}

function chainState(ch) {
  if (!ch.known) return { cls: "p-muted", label: "no RPC in config" };
  if (ch.err) return { cls: "p-bad", label: "read failed" };
  if (ch.guardian === ZERO) return { cls: "p-warn", label: ch.tokens.length ? "no Guardian" : "not set up" };
  if (ch.issues.length) return { cls: "p-bad", label: "Guardian mismatch" };
  if (!ch.tokens.length) return { cls: "p-warn", label: "no tokens watched" };
  const missing = ch.tokens.filter((t) => !t.armed).length;
  if (missing) return { cls: "p-warn", label: `${missing} approval${missing > 1 ? "s" : ""} missing` };
  if (ch.debt > 0n) return { cls: "p-warn", label: "armed, in debt" };
  return { cls: "p-ok", label: "armed", armed: true };
}

async function loadHistory() {
  const g = S.guard;
  const rc = pub(S.rid);
  const n = S.nets[S.rid];
  const head = await rc.getBlockNumber({ cacheTime: 0 });
  const hours = Number(Q.get("history") || S.cfg.historyHours || 6);
  const span = BigInt(Math.ceil((hours * 3600 * 1000) / (n.blockMs || 1000)));
  const from = head > span ? head - span : 0n;
  const step = BigInt(n.maxRange || 1000);
  const ranges = [];
  for (let b = from; b <= head && ranges.length < 400; b += step) ranges.push([b, b + step - 1n < head ? b + step - 1n : head]);
  const names = ["Tripped", "TripMerged", "SweepRequested", "IntentSet", "GuardianSet", "TrustedSet", "TokenAdded", "TokenRemoved", "ThresholdSet", "TripCooldownSet", "OwnerSet"];
  const events = TW.filter((e) => e.type === "event" && names.includes(e.name));
  const chunks = await pool(ranges, 4, ([fromBlock, toBlock]) => rc.getLogs({ address: g.address, events, fromBlock, toBlock }));
  const logs = chunks.flat().sort((x, y) => Number(x.blockNumber - y.blockNumber) || x.logIndex - y.logIndex);
  const blocks = {};
  const wantTs = [...new Set(logs.filter((l) => l.eventName === "Tripped" || l.eventName === "TripMerged").map((l) => l.blockNumber))].slice(-30);
  await pool(wantTs, 4, async (b) => (blocks[b] = Number((await rc.getBlock({ blockNumber: b })).timestamp)));

  // Trips: every id from the counter, enriched with the events in the scanned window.
  const trips = [];
  const total = Number(g.trips);
  for (let id = total; id >= Math.max(1, total - 19); id--) trips.push({ id, merged: [], sweeps: {} });
  const byId = Object.fromEntries(trips.map((t) => [t.id, t]));
  for (const l of logs) {
    const t = byId[Number(l.args.tripId)];
    if (!t) continue;
    if (l.eventName === "Tripped") Object.assign(t, { reason: REASON[l.args.reason], chainId: Number(l.args.chainId), at: blocks[l.blockNumber], tx: l.transactionHash, originTx: V.toHex(l.args.txHash, { size: 32 }) });
    if (l.eventName === "TripMerged") t.merged.push({ reason: REASON[l.args.reason], chainId: Number(l.args.chainId), at: blocks[l.blockNumber] });
    if (l.eventName === "SweepRequested") t.sweeps[Number(l.args.chainId)] = { requested: true };
  }
  // Did each Guardian handle the trip? (Guardian.handled(tripId), exact, no log range needed.)
  await Promise.all(g.chains.filter((c) => c.known && c.guardian !== ZERO && !c.issues.length).map(async (c) => {
    await pool(trips, 4, async (t) => {
      const done = await pub(c.id).readContract({ address: c.guardian, abi: GU, functionName: "handled", args: [BigInt(t.id)] }).catch(() => null);
      t.sweeps[c.id] = { ...(t.sweeps[c.id] || {}), done };
    });
    // Amounts, for sweeps recent enough to be in a short scan of the Guardian's logs.
    try {
      const cc = pub(c.id);
      const n2 = S.nets[c.id];
      const h2 = await cc.getBlockNumber({ cacheTime: 0 });
      const span2 = BigInt(Math.min(Math.ceil((hours * 3600 * 1000) / (n2.blockMs || 1000)), (n2.maxRange || 1000) * 10));
      const st = BigInt(n2.maxRange || 1000);
      const rs = [];
      for (let b = h2 > span2 ? h2 - span2 : 0n; b <= h2; b += st) rs.push([b, b + st - 1n < h2 ? b + st - 1n : h2]);
      const ev = GU.filter((e) => e.type === "event" && (e.name === "Swept" || e.name === "SweepDone"));
      const gl = (await pool(rs, 3, ([fromBlock, toBlock]) => cc.getLogs({ address: c.guardian, events: ev, fromBlock, toBlock }))).flat();
      for (const l of gl) {
        const t = byId[Number(l.args.tripId)];
        if (!t) continue;
        const s = (t.sweeps[c.id] ||= {});
        if (l.eventName === "Swept") (s.moved ||= []).push({ token: l.args.token, amount: l.args.amount });
        if (l.eventName === "SweepDone") Object.assign(s, { swept: Number(l.args.swept), skipped: Number(l.args.skipped), tx: l.transactionHash });
      }
    } catch {}
  }));

  // Pre-cleared payments still live, and the trusted list (latest event per address).
  const now = Math.floor(Date.now() / 1000);
  const intents = {};
  for (const l of logs.filter((l) => l.eventName === "IntentSet")) intents[`${l.args.chainId}:${l.args.token}:${l.args.to}`.toLowerCase()] = l.args;
  const live = Object.values(intents).filter((x) => Number(x.expiry) > now);
  await Promise.all(live.map(async (x) => {
    const key = await rc.readContract({ address: g.address, abi: TW, functionName: "intentKey", args: [x.chainId, x.token, x.to] });
    const [amount, expiry] = await rc.readContract({ address: g.address, abi: TW, functionName: "intents", args: [key] });
    Object.assign(x, { left: amount, liveExpiry: Number(expiry) });
  }));
  const trusted = {};
  for (const l of logs.filter((l) => l.eventName === "TrustedSet")) trusted[l.args.account.toLowerCase()] = l.args;
  const retiredSeen = logs.filter((l) => l.eventName === "GuardianSet");
  return {
    from, head, hours, partial: ranges.length >= 400,
    trips,
    intents: live.filter((x) => x.left > 0n && x.liveExpiry > now),
    trusted: Object.values(trusted).filter((x) => x.trusted).map((x) => x.account),
    guardianSets: retiredSeen,
    changes: logs.filter((l) => !["Tripped", "TripMerged", "SweepRequested", "IntentSet"].includes(l.eventName)).slice(-12).reverse(),
  };
}

async function refresh({ history = false } = {}) {
  if (!S.twAddr || S.loading) return;
  S.loading = true;
  try {
    S.guard = await loadGuard();
    S.guardErr = null;
    // Old Guardians seen in GuardianSet events count as retired too (approvals may be left on them).
    if (S.history) rememberRetired(S.history.guardianSets);
  } catch (e) {
    S.guard = null;
    S.guardErr = e;
  }
  if (S.guard && (history || !S.history)) {
    try {
      S.history = await loadHistory();
      S.histErr = null;
      rememberRetired(S.history.guardianSets);
    } catch (e) {
      S.histErr = errText(e);
    }
  }
  S.loading = false;
  render();
}

function rememberRetired(sets) {
  const per = {};
  for (const l of sets || []) (per[Number(l.args.chainId)] ||= []).push(l.args.guardian);
  for (const [id, list] of Object.entries(per)) {
    const k = `retired:${S.guard?.address}:${id}`;
    const cur = store.get(k) || [];
    for (const a of list.slice(0, -1)) if (a !== ZERO && !cur.some((x) => same(x, a))) cur.push(a);
    store.set(k, cur);
  }
}

// ------------------------------------------------------------------ wallet

const eth = () => window.ethereum;

async function connect() {
  if (!eth()) return toast("No wallet found in this browser. Install one (MetaMask, Rabby, …) or open the page in a wallet's browser.");
  try {
    const accs = await eth().request({ method: "eth_requestAccounts" });
    S.account = accs?.[0] ? V.getAddress(accs[0]) : null;
    S.walletChain = Number(await eth().request({ method: "eth_chainId" }));
    render();
  } catch (e) {
    toast("Wallet: " + errText(e));
  }
}

function hookWallet() {
  if (!eth()?.on) return;
  eth().on("accountsChanged", (a) => {
    S.account = a?.[0] ? V.getAddress(a[0]) : null;
    render();
    walletWaiters.forEach((f) => f());
  });
  eth().on("chainChanged", (c) => {
    S.walletChain = Number(c);
    render();
  });
  // Already connected earlier? eth_accounts doesn't prompt.
  eth().request({ method: "eth_accounts" }).then(async (a) => {
    if (a?.[0]) {
      S.account = V.getAddress(a[0]);
      S.walletChain = Number(await eth().request({ method: "eth_chainId" }));
      render();
    }
  }).catch(() => {});
}
const walletWaiters = new Set();

async function ensureChain(id) {
  const want = "0x" + id.toString(16);
  const cur = Number(await eth().request({ method: "eth_chainId" }));
  if (cur === id) return;
  try {
    await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e) {
    if (e?.code !== 4902 && !/unrecognized|unknown chain|not added/i.test(e?.message || "")) throw e;
    const n = net(id);
    await eth().request({
      method: "wallet_addEthereumChain",
      params: [{ chainId: want, chainName: n.name, rpcUrls: [n.rpc], nativeCurrency: { name: nativeSym(id), symbol: nativeSym(id), decimals: 18 }, ...(n.explorer ? { blockExplorerUrls: [n.explorer] } : {}) }],
    });
    await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] }).catch(() => {});
  }
  const now = Number(await eth().request({ method: "eth_chainId" }));
  if (now !== id) throw new Error(`Your wallet is on chain ${now}; switch it to ${net(id).name} (${id}) and try again.`);
  S.walletChain = id;
}

// ------------------------------------------------------------------ transactions
//
// A plan is a list of steps, each one transaction, each explained before anything is signed:
//   { chain, who: {role, addr} | (ctx) => {role, addr} | null, title, explain: [plain sentences],
//     call: {address, abi, functionName, args, value} | deploy: {abi, bytecode, args, value} | raw: {to, data, value},
//     lazy: (ctx) => partial step (resolved right before sending, for addresses from earlier steps),
//     after: (receipt, ctx) => void }

let modalCancel = null;

function describe(step) {
  if (step.deploy) return `deploy ${step.deployName || "contract"}(${(step.deploy.args || []).map(argText).join(", ")})`;
  if (step.call) return `${short(step.call.address)}.${step.call.functionName}(${(step.call.args || []).map(argText).join(", ")})`;
  if (step.raw) return `to ${short(step.raw.to)} (${(step.raw.data.length - 2) / 2} bytes)`;
  return "";
}
function argText(a) {
  if (Array.isArray(a)) return "[" + a.map(argText).join(", ") + "]";
  if (typeof a === "bigint") return a === MAXU ? "max" : a.toString();
  if (isAddr(a)) return short(a);
  return String(a);
}

function planHtml(plan, state) {
  const mainnetNote = S.mainnet ? `<div class="callout bad"><b>Mainnet.</b> These transactions spend real funds on real chains.</div>` : "";
  return `<div class="dlg">
    <h3 id="dlg-title">${esc(plan.title)}</h3>
    ${plan.intro ? `<p class="muted">${plan.intro}</p>` : ""}
    ${mainnetNote}
    <div id="plan-steps">${plan.steps.map((s, i) => stepHtml(s, i, state[i])).join("")}</div>
    <div id="plan-msg"></div>
    <div class="row end" style="margin-top:12px">
      <button id="plan-cancel" class="ghost">${state.done ? "Close" : "Cancel"}</button>
      ${state.started ? "" : `<button id="plan-go" class="primary">Sign ${plan.steps.length} transaction${plan.steps.length > 1 ? "s" : ""}</button>`}
    </div></div>`;
}
function stepHtml(s, i, st = {}) {
  const who = typeof s.who === "function" ? null : s.who;
  const cls = st.ok ? "okd" : st.err ? "err" : st.cur ? "cur" : "";
  const val = s.call?.value || s.deploy?.value || s.raw?.value;
  return `<div class="tx ${cls}" data-step="${i}">
    <div class="hd"><span class="muted">${i + 1}.</span> ${chip(s.chain)} <span>${esc(s.title)}</span>
      ${who ? `<span class="who ${same(who.addr, S.account) ? "you" : ""}">signed by ${esc(who.role)}${who.addr ? " " + short(who.addr) : ""}</span>` : s.whoText ? `<span class="who">${esc(s.whoText)}</span>` : `<span class="who">any account</span>`}</div>
    <ul>${s.explain.map((x) => `<li>${x}</li>`).join("")}</ul>
    <div class="call">${esc(describe(s))}${val ? ` · sends ${fmt(val)} ${esc(nativeSym(s.chain))}` : ""}</div>
    ${st.msg ? `<div class="st">${st.msg}</div>` : ""}
  </div>`;
}

async function runPlan(plan) {
  if (S.running) return toast("Another set of transactions is still running.");
  if (!plan.steps.length) return toast("Nothing to send.");
  const m = $("#modal");
  const state = plan.steps.map(() => ({}));
  const draw = () => {
    m.innerHTML = planHtml(plan, state);
    $("#plan-cancel").onclick = () => {
      if (modalCancel) modalCancel();
      m.classList.remove("open");
      m.innerHTML = "";
    };
    const go = $("#plan-go");
    if (go) go.onclick = () => start();
  };
  const msg = (h) => ($("#plan-msg").innerHTML = h);
  m.classList.add("open");
  draw();

  let cancelled = false;
  const ctx = { results: [], plan };
  const start = async () => {
    if (!eth()) return msg(`<div class="callout bad">No wallet in this browser.</div>`);
    if (!S.account) await connect();
    if (!S.account) return;
    state.started = true;
    S.running = true;
    modalCancel = () => (cancelled = true);
    draw();
    try {
      for (let i = 0; i < plan.steps.length; i++) {
        if (cancelled) throw new Error("Cancelled.");
        let step = plan.steps[i];
        if (step.lazy) Object.assign(step, step.lazy(ctx));
        const who = typeof step.who === "function" ? step.who(ctx) : step.who;
        state[i] = { cur: true, msg: "Getting ready…" };
        draw();
        $(`[data-step="${i}"]`)?.scrollIntoView({ block: "nearest" });
        if (who?.addr && !same(who.addr, S.account)) {
          state[i].msg = `<span class="warn-t">This one must be signed by the ${esc(who.role)} <span class="addr">${esc(who.addr)}</span>. Switch to that account in your wallet; this continues by itself.</span>`;
          draw();
          await waitForAccount(who.addr, () => cancelled);
        }
        state[i].msg = `Switching your wallet to ${esc(net(step.chain).name)}…`;
        draw();
        await ensureChain(step.chain);
        const account = S.account;
        let tx;
        if (step.call) {
          // Dry run first, so a revert (wrong account, bad input) shows its reason before anything is signed.
          state[i].msg = "Checking it would succeed…";
          draw();
          await pub(step.chain).simulateContract({ ...step.call, account });
          tx = { to: step.call.address, data: V.encodeFunctionData(step.call), value: step.call.value };
        } else if (step.deploy) {
          tx = { data: V.encodeDeployData(step.deploy), value: step.deploy.value };
        } else tx = { ...step.raw };
        state[i].msg = "Confirm it in your wallet…";
        draw();
        const params = { from: account, data: tx.data, ...(tx.to ? { to: tx.to } : {}), ...(tx.value ? { value: V.toHex(tx.value) } : {}) };
        const hash = await eth().request({ method: "eth_sendTransaction", params: [params] });
        state[i].msg = `Sent ${link(step.chain, "tx", hash)}, waiting for it to be included…`;
        draw();
        const rc = await pub(step.chain).waitForTransactionReceipt({ hash, pollingInterval: 1000, timeout: 300_000 });
        if (rc.status !== "success") throw new Error(`Transaction ${hash} reverted.`);
        ctx.results[i] = rc;
        if (step.after) await step.after(rc, ctx);
        state[i] = { ok: true, msg: `<span class="ok-t">Done</span> · ${link(step.chain, "tx", hash)}${rc.contractAddress ? ` · contract ${link(step.chain, "address", rc.contractAddress)}` : ""}` };
        draw();
      }
      state.done = true;
      draw();
      msg(`<div class="callout ok">${plan.doneText || "All done."}</div>`);
    } catch (e) {
      const i = state.findIndex((s) => s.cur && !s.ok);
      if (i >= 0) state[i] = { err: true, msg: `<span class="bad-t">${esc(friendly(e))}</span>` };
      state.done = true;
      draw();
      msg(`<div class="callout bad">Stopped: ${esc(friendly(e))} Steps marked done stay done; open this again to continue from the rest.</div>`);
    } finally {
      S.running = false;
      modalCancel = null;
      if (plan.onEnd) plan.onEnd(ctx);
      if (plan.fast) S.fastUntil = Date.now() + 120_000;
      refresh({ history: true });
    }
  };
}

function friendly(e) {
  const name = e?.cause?.data?.errorName || e?.data?.errorName;
  const hints = {
    NotOwner: "Only the Tripwire owner can do this.",
    BadExpiry: "The pre-clear lifetime must be between 1 second and 1 day.",
    AlreadyWatched: "That token is already watched on this chain.",
    NotWatched: "That token isn't watched on this chain.",
    TooMany: "Over a limit (16 tokens per chain, 8 chains, or a merge window over 1 day).",
    UnknownChain: "That chain isn't one this Tripwire protects.",
    HotIsCold: "HOT and COLD must differ.",
    ZeroAddress: "An address is missing.",
  };
  if (name && hints[name]) return `${hints[name]} (${name})`;
  if (e?.code === 4001 || /user rejected|denied/i.test(e?.message || "")) return "You rejected it in the wallet.";
  return errText(e);
}

function waitForAccount(addr, isCancelled) {
  return new Promise((resolve, reject) => {
    let t;
    const check = async () => {
      if (isCancelled()) return done(reject, new Error("Cancelled."));
      try {
        const a = await eth().request({ method: "eth_accounts" });
        if (a?.[0]) S.account = V.getAddress(a[0]);
      } catch {}
      if (same(S.account, addr)) done(resolve);
    };
    const done = (f, v) => {
      clearInterval(t);
      walletWaiters.delete(check);
      f(v);
    };
    walletWaiters.add(check);
    t = setInterval(check, 1000);
    eth().request({ method: "eth_requestAccounts" }).catch(() => {});
  });
}

// ------------------------------------------------------------------ steps (one place for every explanation)

const role = (r) => {
  const g = S.guard;
  const addr = { HOT: g?.hot, cosigner: g?.cosigner, owner: g?.owner }[r];
  return { role: r, addr };
};
const R = () => net(S.rid).name;

function stepApprove(ch, t, guardian = ch.guardian, hot = S.guard.hot, cold = S.guard.cold) {
  return {
    chain: ch.id, who: { role: "HOT", addr: hot }, title: `Approve the Guardian for ${t.symbol}`,
    explain: [
      `Lets your Guardian <span class="addr">${short(guardian)}</span> pull ${esc(t.symbol)} from HOT, but only to your cold wallet <span class="addr">${short(cold)}</span>, and only when Tripwire trips. It has no other way to move tokens.`,
      `The amount is unlimited on purpose: Tripwire reads any approval to the Guardian below 2<sup>128</sup> as someone cutting the guard, and sweeps.`,
      `Nothing moves now. Costs gas only.`,
    ],
    call: { address: t.address, abi: ERC20, functionName: "approve", args: [guardian, MAXU] },
  };
}

function stepsDeployGuardian(id, g, fund) {
  const proxy = S.nets[id].callbackProxy;
  const key = `pending:${g.address}:${id}`;
  return [
    {
      chain: id, who: null, title: `Deploy your Guardian on ${net(id).name}`, deployName: "Guardian",
      explain: [
        `A small contract with one job: when your Tripwire contract trips, move every approved token from HOT <span class="addr">${short(g.hot)}</span> to COLD <span class="addr">${short(g.cold)}</span>.`,
        `Fixed for good at deploy: HOT, COLD, the only caller it obeys (your Tripwire <span class="addr">${short(g.address)}</span>, through Reactive Network's callback proxy <span class="addr">${short(proxy)}</span>). It can never pay anyone but COLD.`,
        `Any account can send this; it gets no rights over the Guardian.`,
      ],
      deploy: { abi: GU, bytecode: CONTRACTS.Guardian.bytecode, args: [proxy, g.address, g.hot, g.cold] },
      after: (rc, ctx) => {
        (ctx.guardians ||= {})[id] = rc.contractAddress;
        store.set(key, rc.contractAddress);
      },
    },
    ...(fund > 0n ? [{
      chain: id, who: null, title: `Fund the Guardian's callback reserves`,
      explain: [
        `Reactive Network's callback proxy on ${esc(net(id).name)} bills the Guardian for every sweep it delivers. This deposits ${fmt(fund)} ${esc(nativeSym(id))} for those bills; whatever isn't used stays credited to the Guardian.`,
        `A Guardian in debt gets no callbacks, so keep this topped up.`,
      ],
      lazy: (ctx) => ({ call: { address: proxy, abi: PAYEE, functionName: "depositTo", args: [ctx.guardians[id]], value: fund } }),
      call: { address: proxy, abi: PAYEE, functionName: "depositTo", args: ["(new Guardian)"], value: fund },
    }] : []),
    {
      chain: S.rid, who: role("owner"), title: `Point Tripwire at the new Guardian`,
      explain: [
        `Tells your Tripwire contract on ${esc(R())} which Guardian to call on ${esc(net(id).name)} when it trips. Only the owner can.`,
        `It can't redirect funds: every Guardian can only ever pay COLD.`,
      ],
      lazy: (ctx) => ({ call: { address: g.address, abi: TW, functionName: "setGuardian", args: [BigInt(id), ctx.guardians[id]] } }),
      call: { address: g.address, abi: TW, functionName: "setGuardian", args: [BigInt(id), "(new Guardian)"] },
      after: () => store.set(key, null),
    },
  ];
}

function stepSetGuardian(id, guardian) {
  return {
    chain: S.rid, who: role("owner"), title: `Point Tripwire at Guardian ${short(guardian)}`,
    explain: [
      `Tells your Tripwire contract on ${esc(R())} to call Guardian <span class="addr">${short(guardian)}</span> on ${esc(net(id).name)} when it trips. Only the owner can.`,
      `It can't redirect funds: every Guardian can only ever pay COLD.`,
    ],
    call: { address: S.guard.address, abi: TW, functionName: "setGuardian", args: [BigInt(id), guardian] },
    after: () => store.set(`pending:${S.guard.address}:${id}`, null),
  };
}

function stepAddToken(id, tok, threshold, twAddr = S.guard?.address, owner = role("owner")) {
  return {
    chain: S.rid, who: owner, title: `Watch ${tok.symbol} on ${net(id).short || net(id).name}`,
    explain: [
      `Tripwire subscribes to ${esc(tok.symbol)}'s Transfer and Approval events from HOT on ${esc(net(id).name)} and includes it in every sweep there.`,
      threshold > 0n ? `Moves of up to ${fmt(threshold, tok.decimals)} ${esc(tok.symbol)} never trip.` : `Any untrusted move of it trips (threshold 0).`,
      `HOT still has to approve the Guardian for it; that is a separate step.`,
    ],
    call: { address: twAddr, abi: TW, functionName: "addToken", args: [BigInt(id), tok.address, threshold] },
  };
}

function stepPanic(ch) {
  const g = S.guard;
  const others = g.chains.filter((c) => c.guardian !== ZERO).map((c) => net(c.id).short || net(c.id).name).join(", ");
  const asHot = same(S.account, g.hot) && !same(g.hot, g.cosigner);
  return {
    chain: ch.id, who: same(S.account, g.hot) ? role("HOT") : role("cosigner"), title: `Press panic on ${net(ch.id).name}`,
    explain: [
      `Tripwire sweeps every approved token from HOT to COLD <span class="addr">${short(g.cold)}</span> on every protected chain (${esc(others || "none set up yet")}), not only ${esc(net(ch.id).short || "this one")}.`,
      asHot
        ? `You're pressing it from HOT. That fires unless a trip happened in the last ${dur(g.cooldown)} (so a thief holding HOT can't spam it). From the cosigner it always fires.`
        : `From the cosigner it always fires, merge window or not.`,
      `Costs gas only. Everything lands in COLD, which you control; send back what you need afterwards.`,
    ],
    call: { address: ch.panic, abi: PB, functionName: "panic", args: [] },
  };
}

function stepsDisarm(ch) {
  const g = S.guard;
  const steps = [{
    chain: S.rid, who: role("owner"), title: `Stop sweeping ${net(ch.id).name}`,
    explain: [
      `Tripwire forgets this chain's Guardian <span class="addr">${short(ch.guardian)}</span>: a trip no longer sweeps ${esc(net(ch.id).name)}. Other chains stay armed.`,
      `This goes first on purpose. Revoking the Guardian's approval while Tripwire still points at it looks exactly like a thief cutting the guard, and sweeps everything to COLD.`,
    ],
    call: { address: g.address, abi: TW, functionName: "setGuardian", args: [BigInt(ch.id), ZERO] },
    after: () => {
      const k = `retired:${g.address}:${ch.id}`;
      const cur = store.get(k) || [];
      if (!cur.some((x) => same(x, ch.guardian))) cur.push(ch.guardian);
      store.set(k, cur);
    },
  }];
  for (const t of ch.tokens.filter((t) => t.allowance > 0n)) steps.push(stepRevoke(ch.id, t, ch.guardian));
  return steps;
}

function stepRevoke(id, t, guardian) {
  return {
    chain: id, who: role("HOT"), title: `Revoke the old Guardian's ${t.symbol} approval`,
    explain: [
      `Sets HOT's ${esc(t.symbol)} allowance for <span class="addr">${short(guardian)}</span> to 0.`,
      `Tripwire no longer points at that Guardian, so this clears without a sweep.`,
    ],
    call: { address: t.address, abi: ERC20, functionName: "approve", args: [guardian, 0n] },
  };
}

// ------------------------------------------------------------------ actions

const ACT = {
  connect,
  refresh: () => refresh({ history: true }),
  theme() {
    const r = document.documentElement;
    const dark = r.dataset.theme ? r.dataset.theme === "dark" : !matchMedia("(prefers-color-scheme: light)").matches;
    r.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("tripwire-arm:theme", r.dataset.theme); } catch {}
  },
  view(el) {
    S.view = el.dataset.v;
    render();
  },
  async loadGuard() {
    const v = $("#tw-in").value.trim();
    if (!isAddr(v)) return toast("That isn't an address.");
    S.twAddr = V.getAddress(v);
    S.twSource = "entered";
    store.set("tripwire", S.twAddr);
    S.guard = S.history = null;
    S.view = "manage";
    render();
    await refresh({ history: true });
  },
  forget() {
    store.set("tripwire", null);
    S.twAddr = isAddr(S.cfg.tripwire) ? V.getAddress(S.cfg.tripwire) : null;
    S.twSource = S.twAddr ? "config" : "";
    S.guard = S.history = S.guardErr = null;
    S.view = S.twAddr ? "manage" : "new";
    render();
    refresh({ history: true });
  },
  armChain(el) {
    const ch = chainOf(el);
    runPlan({ title: `Arm ${net(ch.id).name}`, intro: "HOT approves the Guardian for each watched token. Each approval is one transaction.", steps: ch.tokens.filter((t) => !t.armed && !t.missing).map((t) => stepApprove(ch, t)), doneText: `${esc(net(ch.id).name)} is armed.` });
  },
  armAll() {
    runPlan({ title: "Finish setting up", intro: "Everything still missing, in order. Steps for different accounts pause until you switch to that account.", steps: setupSteps(), doneText: "Your guard is armed on every chain it protects." });
  },
  deployGuardian(el) {
    const ch = chainOf(el);
    const fund = parseAmt($(`#fund-${ch.id}`)?.value || "0", 18);
    if (fund == null) return toast("Reserve amount isn't a number.");
    runPlan({ title: `Guardian for ${net(ch.id).name}`, steps: [...stepsDeployGuardian(ch.id, S.guard, fund), ...ch.tokens.filter((t) => !t.missing).map((t) => ({ ...stepApprove(ch, t, "(new Guardian)"), lazy: (ctx) => ({ call: { address: t.address, abi: ERC20, functionName: "approve", args: [ctx.guardians[ch.id], MAXU] } }) }))] });
  },
  async useGuardian(el) {
    const ch = chainOf(el);
    const a = $(`#use-g-${ch.id}`).value.trim();
    if (!isAddr(a)) return toast("That isn't an address.");
    const problem = await checkGuardian(ch.id, a);
    if (problem) return toast(problem);
    runPlan({ title: `Use Guardian ${short(a)} on ${net(ch.id).name}`, steps: [stepSetGuardian(ch.id, V.getAddress(a))] });
  },
  setPending(el) {
    const ch = chainOf(el);
    runPlan({ title: `Connect the Guardian on ${net(ch.id).name}`, steps: [stepSetGuardian(ch.id, ch.pending)] });
  },
  deploySignals(el) {
    const ch = chainOf(el);
    runPlan({ title: `Panic and pre-clear on ${net(ch.id).name}`, steps: signalSteps(ch.id, { intent: !ch.intentOk, panic: !ch.panicOk }) });
  },
  disarm(el) {
    const ch = chainOf(el);
    runPlan({ title: `Disarm ${net(ch.id).name}`, intro: "Two accounts take part: the owner stops the sweeps first, then HOT revokes its approvals. The page waits for you to switch accounts in between.", steps: stepsDisarm(ch), doneText: `${esc(net(ch.id).name)} is disarmed: no sweeps there, no approvals left.` });
  },
  revokeLeft(el) {
    const ch = chainOf(el);
    runPlan({ title: `Revoke leftover approvals on ${net(ch.id).name}`, steps: ch.leftovers.map((l) => stepRevoke(ch.id, l.token, l.guardian)) });
  },
  panic() {
    const ch = S.guard.chains.find((c) => c.id === Number($("#panic-chain").value));
    if (!ch) return;
    runPlan({ title: "Panic", steps: [stepPanic(ch)], fast: true, doneText: "Pressed. Tripwire reacts within a few blocks; the trip and each chain's sweep appear under History." });
  },
  async preclear() {
    const g = S.guard;
    const [id, tokenAddr] = ($("#pc-token").value || ":").split(":");
    const ch = g.chains.find((c) => c.id === Number(id));
    const t = ch?.tokens.find((x) => same(x.address, tokenAddr));
    const to = $("#pc-to").value.trim();
    const amount = parseAmt($("#pc-amount").value, t?.decimals ?? 18);
    const mins = Number($("#pc-mins").value);
    if (!t) return toast("Pick a token.");
    if (!isAddr(to)) return toast("The recipient isn't an address.");
    if (amount == null) return toast("The amount isn't a number.");
    if (!(mins > 0 && mins <= MAX_TTL_MIN)) return toast("Lifetime: 1 to 1440 minutes.");
    runPlan({
      title: "Pre-clear a payment",
      steps: [{
        chain: ch.id, who: role("cosigner"), title: amount === 0n ? `Cancel the pre-clear for ${short(to)}` : `Pre-clear ${fmt(amount, t.decimals)} ${t.symbol} to ${short(to)}`,
        explain: amount === 0n ? [`Cancels any pre-clear of ${esc(t.symbol)} to <span class="addr">${short(to)}</span> on ${esc(net(ch.id).name)}.`] : [
          `For the next ${dur(mins * 60)}, HOT may send or approve up to ${fmt(amount, t.decimals)} ${esc(t.symbol)} to <span class="addr">${esc(to)}</span> on ${esc(net(ch.id).name)} without a sweep. The amount is used up as transfers arrive.`,
          `Tripwire only accepts this from the cosigner <span class="addr">${short(g.cosigner)}</span>, so a thief with only the HOT key can't pre-clear a drain.`,
          `Wait until it shows under "Pre-cleared payments" (a few blocks), then send the payment from HOT.`,
        ],
        call: { address: ch.intent, abi: IN, functionName: "intendFor", args: [t.address, to, amount, BigInt(Math.round(mins * 60))] },
      }],
      fast: true,
    });
  },
  async ownerAddToken() {
    const id = Number($("#ow-chain").value);
    const a = $("#ow-token").value.trim();
    if (!isAddr(a)) return toast("The token isn't an address.");
    const meta = await tokenMeta(id, a).catch((e) => ({ err: errText(e) }));
    if (meta.err) return toast(meta.err);
    const th = parseAmt($("#ow-th").value || "0", meta.decimals);
    if (th == null) return toast("The threshold isn't a number.");
    const ch = S.guard.chains.find((c) => c.id === id);
    const steps = [stepAddToken(id, meta, th)];
    if (ch?.guardian !== ZERO && ch?.known) steps.push(stepApprove(ch, meta));
    runPlan({ title: `Watch ${meta.symbol}`, steps });
  },
  ownerThreshold() {
    const t = pickedToken("#ow-tok2");
    if (!t) return toast("Pick a token.");
    const th = parseAmt($("#ow-th2").value || "0", t.t.decimals);
    if (th == null) return toast("The threshold isn't a number.");
    runPlan({ title: "Change a threshold", steps: [{
      chain: S.rid, who: role("owner"), title: `Threshold for ${t.t.symbol} on ${net(t.ch.id).short}: ${fmt(th, t.t.decimals)}`,
      explain: [`From now on, moves of up to ${fmt(th, t.t.decimals)} ${esc(t.t.symbol)} from HOT on ${esc(net(t.ch.id).name)} clear without a sweep; bigger ones trip (unless trusted or pre-cleared).`],
      call: { address: S.guard.address, abi: TW, functionName: "setThreshold", args: [BigInt(t.ch.id), t.t.address, th] },
    }] });
  },
  ownerRemoveToken() {
    const t = pickedToken("#ow-tok2");
    if (!t) return toast("Pick a token.");
    runPlan({ title: "Stop watching a token", steps: [{
      chain: S.rid, who: role("owner"), title: `Stop watching ${t.t.symbol} on ${net(t.ch.id).short}`,
      explain: [
        `Tripwire unsubscribes from ${esc(t.t.symbol)} on ${esc(net(t.ch.id).name)} and leaves it out of sweeps: it is no longer protected.`,
        `HOT's approval to the Guardian stays until you revoke it; once unwatched, revoking it doesn't trip.`,
      ],
      call: { address: S.guard.address, abi: TW, functionName: "removeToken", args: [BigInt(t.ch.id), t.t.address] },
    }] });
  },
  ownerTrust(el) {
    const a = (el.dataset.addr || $("#ow-trust").value).trim();
    const on = el.dataset.on === "1";
    if (!isAddr(a)) return toast("That isn't an address.");
    runPlan({ title: on ? "Trust an address" : "Stop trusting an address", steps: [{
      chain: S.rid, who: role("owner"), title: `${on ? "Trust" : "Untrust"} ${short(a)}`,
      explain: on ? [
        `Transfers and approvals from HOT to <span class="addr">${esc(a)}</span> never trip, on every chain and for every token.`,
        `Use it for addresses you control or fully trust (an exchange deposit address, the pool you swap through). Anything sent there is out of Tripwire's reach.`,
      ] : [`Moves from HOT to <span class="addr">${esc(a)}</span> are judged like any other again.`],
      call: { address: S.guard.address, abi: TW, functionName: "setTrusted", args: [a, on] },
    }] });
  },
  ownerCooldown() {
    const s = Number($("#ow-cd").value);
    if (!(s >= 0 && s <= 86400) || !Number.isInteger(s)) return toast("Merge window: 0 to 86400 seconds.");
    runPlan({ title: "Change the merge window", steps: [{
      chain: S.rid, who: role("owner"), title: `Merge window: ${s ? dur(s) : "same transaction only"}`,
      explain: [
        `After a trip, untrusted moves in the next ${s ? dur(s) : "0 s"} fold into it without new sweeps (a cosigner panic always fires).`,
        `Longer spends less when a thief keeps poking; shorter re-arms sooner after a sweep.`,
      ],
      call: { address: S.guard.address, abi: TW, functionName: "setTripCooldown", args: [BigInt(s)] },
    }] });
  },
  ownerTransfer() {
    const a = $("#ow-owner").value.trim();
    if (!isAddr(a)) return toast("That isn't an address.");
    runPlan({ title: "Hand over ownership", steps: [{
      chain: S.rid, who: role("owner"), title: `New owner: ${short(a)}`,
      explain: [
        `<span class="addr">${esc(a)}</span> becomes the only account that can change tokens, thresholds, trusted addresses, Guardians and the merge window. You lose that right.`,
        same(a, S.guard.hot) ? `<b class="bad-t">That is the HOT wallet. A thief with the HOT key could then trust their own address and drain without a trip.</b>` : `Keep it off the HOT wallet: the cosigner or a separate key is right.`,
      ],
      call: { address: S.guard.address, abi: TW, functionName: "setOwner", args: [a] },
    }] });
  },
  topUp() {
    const [kind, id] = $("#tu-target").value.split(":");
    const amt = parseAmt($("#tu-amount").value, 18);
    if (!amt) return toast("Enter an amount.");
    const g = S.guard;
    if (kind === "tw") {
      runPlan({ title: "Top up Tripwire", steps: [{
        chain: S.rid, who: null, title: `Add ${fmt(amt)} ${nativeSym(S.rid)} to Tripwire's reserves`,
        explain: [`Reactive Network bills your Tripwire contract for each reaction and each callback it requests. This credits ${fmt(amt)} ${esc(nativeSym(S.rid))} to it at the system contract. A contract in debt stops reacting.`, `Any account can pay.`],
        call: { address: SYSTEM, abi: PAYEE, functionName: "depositTo", args: [g.address], value: amt },
      }] });
    } else {
      const ch = g.chains.find((c) => c.id === Number(id));
      runPlan({ title: "Top up a Guardian", steps: [{
        chain: ch.id, who: null, title: `Add ${fmt(amt)} ${nativeSym(ch.id)} to the Guardian's callback reserves`,
        explain: [`The callback proxy on ${esc(net(ch.id).name)} bills the Guardian for each sweep it delivers. This credits ${fmt(amt)} ${esc(nativeSym(ch.id))} to it. A Guardian in debt gets no callbacks.`, `Any account can pay.`],
        call: { address: S.nets[ch.id].callbackProxy, abi: PAYEE, functionName: "depositTo", args: [ch.guardian], value: amt },
      }] });
    }
  },
  coverDebt() {
    runPlan({ title: "Settle Tripwire's debt", steps: [{
      chain: S.rid, who: null, title: "Pay the system contract from Tripwire's own balance",
      explain: [`Pays any debt your Tripwire contract owes Reactive Network out of the ${esc(nativeSym(S.rid))} it holds, so it reacts again. Any account can call it.`],
      call: { address: S.guard.address, abi: TW, functionName: "coverDebt", args: [] },
    }] });
  },
  wizardReview: () => wizardReview(),
  copy(el) {
    navigator.clipboard?.writeText(el.dataset.copy).then(() => toast("Copied."), () => {});
  },
};

function chainOf(el) {
  return S.guard.chains.find((c) => c.id === Number(el.closest("[data-chain]").dataset.chain));
}
function pickedToken(sel) {
  const [id, a] = ($(sel)?.value || ":").split(":");
  const ch = S.guard.chains.find((c) => c.id === Number(id));
  const t = ch?.tokens.find((x) => same(x.address, a));
  return t ? { ch, t } : null;
}
function parseAmt(s, dec) {
  s = String(s ?? "").trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  try {
    return V.parseUnits(s, dec);
  } catch {
    return null;
  }
}
async function tokenMeta(id, a) {
  const c = pub(id);
  const code = await c.getCode({ address: a });
  if (!code || code === "0x") throw new Error(`No contract at ${short(a)} on ${net(id).name}.`);
  const [symbol, decimals] = await Promise.all([
    c.readContract({ address: a, abi: ERC20, functionName: "symbol" }).catch(() => short(a)),
    c.readContract({ address: a, abi: ERC20, functionName: "decimals" }),
  ]);
  return { address: V.getAddress(a), symbol, decimals: Number(decimals) };
}
async function checkGuardian(id, a, g = S.guard) {
  try {
    const c = pub(id);
    const code = await c.getCode({ address: a });
    if (!code || code === "0x") return `No contract at ${short(a)} on ${net(id).name}.`;
    const gr = (fn) => c.readContract({ address: a, abi: GU, functionName: fn });
    const [h, co, s, p] = await Promise.all([gr("HOT"), gr("COLD"), gr("_CALLBACK_SENDER"), gr("_SERVICE_PROVIDER")]);
    if (!same(h, g.hot) || !same(co, g.cold)) return "That Guardian protects a different HOT/COLD pair.";
    if (!same(s, g.address)) return "That Guardian obeys a different Tripwire contract.";
    if (!same(p, S.nets[id].callbackProxy)) return "That Guardian uses a different callback proxy.";
    return null;
  } catch (e) {
    return "Not a Guardian: " + errText(e);
  }
}

function signalSteps(id, need = { intent: true, panic: true }) {
  const mk = (name, bytecode, what) => ({
    chain: id, who: null, title: `Deploy ${name} on ${net(id).name}`,
    explain: [what, `Deployed through the standard CREATE2 factory, so it lands at <span class="addr">${short(signalAddr(bytecode))}</span>, the same address on every chain. Any account can send it, and it holds no funds.`],
    raw: { to: FACTORY, data: V.concat([SALT, bytecode]) },
  });
  return [
    ...(need.intent ? [mk("Intent", CONTRACTS.Intent.bytecode, "Intent is where the cosigner pre-clears a payment from HOT, so a planned payment doesn't sweep.")] : []),
    ...(need.panic ? [mk("PanicButton", CONTRACTS.PanicButton.bytecode, "PanicButton is the button HOT or the cosigner press to sweep every chain at once.")] : []),
  ];
}

// Everything missing for the loaded guard, across chains, in the order that works.
function setupSteps() {
  const g = S.guard;
  const steps = [];
  for (const ch of g.chains.filter((c) => c.known && !c.err)) {
    if (ch.guardian === ZERO) {
      if (!ch.tokens.length) continue; // nothing to protect here yet
      if (ch.pending) steps.push(stepSetGuardian(ch.id, ch.pending));
      else steps.push(...stepsDeployGuardian(ch.id, g, parseAmt($(`#fund-${ch.id}`)?.value || defaultGuardianFund(), 18) || 0n));
      for (const t of ch.tokens.filter((t) => !t.missing)) {
        const s = stepApprove(ch, t, ch.pending || "(new Guardian)");
        if (!ch.pending) s.lazy = (ctx) => ({ call: { address: t.address, abi: ERC20, functionName: "approve", args: [ctx.guardians[ch.id], MAXU] } });
        steps.push(s);
      }
    } else if (!ch.issues.length) {
      for (const t of ch.tokens.filter((t) => !t.armed && !t.missing)) steps.push(stepApprove(ch, t));
    }
  }
  // Group by signer, so the wallet switches accounts as few times as possible: anyone/owner first, HOT last.
  const rank = (s) => (s.who?.role === "HOT" ? 2 : s.who?.role === "owner" ? 1 : 0);
  return steps.map((s, i) => [s, i]).sort((a, b) => (rank(a[0]) === 2) - (rank(b[0]) === 2) || a[1] - b[1]).map(([s]) => s);
}
const defaultGuardianFund = () => String(S.cfg.guardianFund ?? "0.002");
const defaultReactiveFund = () => String(S.cfg.reactiveFund ?? (S.mainnet ? "1" : "2"));

// ------------------------------------------------------------------ new guard (deploy TripwireReactive)

async function wizardReview() {
  const v = (id) => $(id)?.value.trim() || "";
  const hot = v("#nw-hot"), cold = v("#nw-cold"), cos = v("#nw-cos");
  const ids = destIds().filter((id) => $(`#nw-c-${id}`)?.checked);
  const errs = [];
  if (!isAddr(hot)) errs.push("HOT isn't an address.");
  if (!isAddr(cold)) errs.push("COLD isn't an address.");
  if (!isAddr(cos)) errs.push("The cosigner isn't an address.");
  if (same(hot, cold)) errs.push("HOT and COLD must differ.");
  if (!ids.length) errs.push("Pick at least one chain.");
  const fund = parseAmt(v("#nw-fund") || "0", 18);
  const gfund = parseAmt(v("#nw-gfund") || "0", 18);
  if (fund == null || gfund == null) errs.push("A funding amount isn't a number.");
  const out = $("#nw-out");
  if (errs.length) return (out.innerHTML = `<div class="callout bad">${errs.map(esc).join("<br>")}</div>`);
  out.innerHTML = `<p class="muted">Checking the chains…</p>`;

  // Per chain: Intent/PanicButton (config addresses, else the CREATE2 ones; deploy if missing) and tokens to watch.
  const plan = { title: "Set up your guard", steps: [], intro: "Each step is one transaction. The page waits for you to switch accounts where a step needs a different signer." };
  const chains = [];
  try {
    for (const id of ids) {
      const c = pub(id);
      const n = S.nets[id];
      const intent = isAddr(n.intent) ? n.intent : signalAddr(CONTRACTS.Intent.bytecode);
      const panic = isAddr(n.panic) ? n.panic : signalAddr(CONTRACTS.PanicButton.bytecode);
      const [ic, pc, fc] = await Promise.all([c.getCode({ address: intent }), c.getCode({ address: panic }), c.getCode({ address: FACTORY })]);
      const need = { intent: !ic || ic === "0x", panic: !pc || pc === "0x" };
      if ((need.intent && isAddr(n.intent)) || (need.panic && isAddr(n.panic))) throw new Error(`${n.name}: the Intent/PanicButton in the config has no code.`);
      if ((need.intent || need.panic) && (!fc || fc === "0x")) throw new Error(`${n.name} has no CREATE2 factory; deploy Intent and PanicButton with script/DeploySignals.s.sol and put them in the config.`);
      const toks = [];
      const typed = v(`#nw-t-${id}`).split(/[\s,]+/).filter(Boolean);
      const picks = [...$$(`[data-nwtok="${id}"]`)].filter((x) => x.checked).map((x) => x.value);
      for (const a of [...new Set([...picks, ...typed].map((x) => x.toLowerCase()))]) {
        if (!isAddr(a)) throw new Error(`${n.name}: ${a} isn't an address.`);
        toks.push(await tokenMeta(id, a));
      }
      if (toks.length > 16) throw new Error(`${n.name}: at most 16 tokens.`);
      chains.push({ id, intent, panic, need, toks });
    }
  } catch (e) {
    return (out.innerHTML = `<div class="callout bad">${esc(errText(e))}</div>`);
  }

  for (const c of chains) plan.steps.push(...signalSteps(c.id, c.need));
  const ownerWho = (ctx) => ({ role: "owner", addr: ctx.owner });
  plan.steps.push({
    chain: S.rid, who: null, whoText: "becomes the owner", deployName: "TripwireReactive",
    title: `Deploy your Tripwire contract on ${R()}`,
    explain: [
      `Creates the contract that watches HOT <span class="addr">${short(hot)}</span> on ${andList(chains.map((c) => esc(net(c.id).name)))}, and decides when to sweep. HOT, COLD <span class="addr">${short(cold)}</span>, the cosigner <span class="addr">${short(cos)}</span> and the chains are fixed for good.`,
      `The account that sends this becomes the owner: it can change tokens, thresholds, trusted addresses and Guardians, but never where funds go. Send it from the cosigner or a separate key, not from HOT.`,
      `It carries ${fmt(fund)} ${esc(nativeSym(S.rid))} to pay Reactive Network for reactions and callbacks.`,
    ],
    deploy: { abi: TW, bytecode: CONTRACTS.TripwireReactive.bytecode, args: [hot, cold, cos, chains.map((c) => BigInt(c.id)), chains.map((c) => c.intent), chains.map((c) => c.panic)], value: fund },
    after: (rc, ctx) => {
      ctx.tw = rc.contractAddress;
      ctx.owner = S.account;
      ctx.guardians = {};
      S.twAddr = V.getAddress(rc.contractAddress);
      S.twSource = "saved";
      store.set("tripwire", S.twAddr);
    },
  });
  const fakeG = { hot, cold, address: "(new Tripwire)" };
  for (const c of chains) {
    const gs = stepsDeployGuardian(c.id, fakeG, gfund);
    // Addresses from earlier steps are filled in right before each one is sent.
    gs[0].lazy = (ctx) => ({ deploy: { abi: GU, bytecode: CONTRACTS.Guardian.bytecode, args: [S.nets[c.id].callbackProxy, ctx.tw, hot, cold] } });
    gs[0].after = (rc, ctx) => {
      ctx.guardians[c.id] = rc.contractAddress;
      store.set(`pending:${ctx.tw}:${c.id}`, rc.contractAddress);
    };
    const set = gs[gs.length - 1];
    set.who = ownerWho;
    set.lazy = (ctx) => ({ call: { address: ctx.tw, abi: TW, functionName: "setGuardian", args: [BigInt(c.id), ctx.guardians[c.id]] } });
    set.after = (rc, ctx) => store.set(`pending:${ctx.tw}:${c.id}`, null);
    plan.steps.push(...gs);
    for (const t of c.toks) {
      const s = stepAddToken(c.id, t, 0n, "(new Tripwire)", ownerWho);
      s.lazy = (ctx) => ({ call: { address: ctx.tw, abi: TW, functionName: "addToken", args: [BigInt(c.id), t.address, 0n] } });
      plan.steps.push(s);
    }
  }
  for (const c of chains) {
    for (const t of c.toks) {
      const s = stepApprove({ id: c.id }, t, "(new Guardian)", hot, cold);
      s.lazy = (ctx) => ({ call: { address: t.address, abi: ERC20, functionName: "approve", args: [ctx.guardians[c.id], MAXU] } });
      plan.steps.push(s);
    }
  }
  plan.doneText = "Your guard is deployed and armed. Thresholds and trusted addresses can be set under Rules.";
  plan.onEnd = () => {
    if (S.twAddr) {
      S.view = "manage";
      S.guard = S.history = null;
    }
  };
  out.innerHTML = "";
  runPlan(plan);
}

// ------------------------------------------------------------------ rendering

function header() {
  const g = S.guard;
  const roles = [];
  if (g && S.account) {
    if (same(S.account, g.hot)) roles.push("HOT");
    if (same(S.account, g.cosigner)) roles.push("cosigner");
    if (same(S.account, g.owner)) roles.push("owner");
    if (same(S.account, g.cold)) roles.push("COLD");
  }
  const monitorQ = new URLSearchParams();
  if (S.twAddr) monitorQ.set("tripwire", S.twAddr);
  if (Q.get("config")) monitorQ.set("config", Q.get("config"));
  else if (NET === "mainnet") monitorQ.set("net", "mainnet");
  return `<div class="brand"><span class="logo">⟟</span> Tripwire <span class="sub">arm and manage your guard</span></div>
  <div class="hdr-right">
    ${S.mainnet ? `<span class="pill p-bad" title="Real funds">Mainnet</span>` : `<span class="pill p-info">${esc(net(S.rid).name)}</span>`}
    ${S.otherNets.map(([k, l]) => `<a href="?net=${k}">${l}</a>`).join("")}
    <a href="../?${esc(monitorQ.toString())}">Monitor</a>
    <button class="ghost" data-act="theme" title="Light/dark">◐</button>
    ${S.account
      ? `<span class="mono" title="${esc(S.account)}">${short(S.account)}</span>${roles.map((r) => `<span class="pill p-ok">${r}</span>`).join("")}${g && !roles.length ? `<span class="pill p-muted">no role</span>` : ""}${S.walletChain ? chip(S.walletChain) : ""}`
      : `<button class="primary" data-act="connect" id="connect">${eth() ? "Connect wallet" : "No wallet found"}</button>`}
  </div>`;
}

function guardPicker() {
  const placeholder = S.cfg.tripwire && !isAddr(S.cfg.tripwire);
  return `<section class="panel">
    <h2>Your guard ${S.guard ? `<span class="pill ${overall().cls}">${overall().label}</span>` : ""}</h2>
    <div class="row">
      <input id="tw-in" class="addr-in" style="flex:1 1 340px" placeholder="Tripwire contract address on ${esc(R())} (0x…)" value="${esc(S.twAddr || "")}" spellcheck="false" autocomplete="off">
      <button data-act="loadGuard">Open</button>
      ${S.twSource === "saved" || S.twSource === "entered" ? `<button class="ghost" data-act="forget" title="Forget the guard this browser remembers">Forget</button>` : ""}
      <span class="spacer"></span>
      ${S.view === "new" && !S.twAddr ? "" : `<button data-act="view" data-v="${S.view === "new" ? "manage" : "new"}">${S.view === "new" ? "Back to my guard" : "Set up a new guard"}</button>`}
    </div>
    ${!S.twAddr ? `<div class="callout info" style="margin-top:10px"><b>No Tripwire deployed yet</b> for ${esc(R())} in this page's config${placeholder ? ` (it holds a placeholder, <span class="mono">${esc(S.cfg.tripwire)}</span>)` : ""}. Paste the address of yours above, or set up a new guard below: it takes a few minutes and one transaction per step.</div>` : ""}
    ${S.twSource === "config" ? `<p class="muted small">Showing the guard from the page's config (${esc(CFG_FILE)}). Paste yours to manage it; this browser remembers it.</p>` : ""}
  </section>`;
}

function overall() {
  const g = S.guard;
  const st = g.chains.map(chainState);
  const armed = st.filter((s) => s.armed).length;
  if (armed === g.chains.length) return { cls: "p-ok", label: `armed on ${armed === 1 ? "its chain" : `all ${armed} chains`}` };
  if (!armed) return { cls: "p-warn", label: "not armed yet" };
  return { cls: "p-warn", label: `armed on ${armed} of ${g.chains.length} chains` };
}

function youAre(r) {
  const a = { HOT: S.guard.hot, cosigner: S.guard.cosigner, owner: S.guard.owner }[r];
  return same(a, S.account) ? `<span class="who you">you</span>` : "";
}

function summary() {
  const g = S.guard;
  const warn = [];
  if (same(g.owner, g.hot)) warn.push(`<b>The owner is the HOT wallet.</b> A thief holding that key could trust their own address on Reactive Network and then drain without a trip. Hand ownership to the cosigner under Rules.`);
  if (same(g.cosigner, g.hot)) warn.push(`<b>The cosigner is the HOT wallet.</b> A thief holding that key can pre-clear their own drain. This is fixed at deploy; a new guard with a separate cosigner fixes it.`);
  if (g.sysDebt > 0n) warn.push(`Tripwire owes Reactive Network ${fmt(g.sysDebt)} ${esc(nativeSym(S.rid))} and stops reacting while in debt. Top it up or settle from its balance (below).`);
  if (g.balance === 0n) warn.push(`Tripwire's balance on ${esc(R())} is 0: it can't pay for reactions. Top it up below.`);
  const now = Date.now() / 1000;
  const window = g.lastTripAt && now < g.lastTripAt + g.cooldown ? ` · <span class="warn-t">inside the merge window for ${dur(Math.ceil(g.lastTripAt + g.cooldown - now))} more</span>` : "";
  return `<section class="panel">
    <h2>${chip(S.rid)} Tripwire ${link(S.rid, "address", g.address, g.address)}</h2>
    <div class="kv">
      <div><span class="k">HOT, the wallet it guards ${youAre("HOT")}</span>${link(S.rid, "address", g.hot, g.hot)}</div>
      <div><span class="k">COLD, where sweeps go</span>${link(S.rid, "address", g.cold, g.cold)}</div>
      <div><span class="k">Cosigner: pre-clears, panic ${youAre("cosigner")}</span>${link(S.rid, "address", g.cosigner, g.cosigner)}</div>
      <div><span class="k">Owner: changes the rules ${youAre("owner")}</span>${link(S.rid, "address", g.owner, g.owner)}</div>
      <div><span class="k">Trips so far</span>${g.trips.toString()}${g.lastTripAt ? ` · last ${ago(g.lastTripAt)}` : ""}${window}</div>
      <div><span class="k">Merge window</span>${g.cooldown ? dur(g.cooldown) : "same transaction only"}</div>
      <div><span class="k">Balance on ${esc(net(S.rid).short || R())}</span>${fmt(g.balance)} ${esc(nativeSym(S.rid))}${g.sysDebt != null ? ` · debt ${fmt(g.sysDebt)}` : ""}</div>
    </div>
    ${warn.map((w) => `<div class="callout bad">${w}</div>`).join("")}
    ${roleNote()}
  </section>`;
}

function roleNote() {
  const g = S.guard;
  if (!S.account) return `<p class="muted small">Read-only. Connect a wallet to act: HOT arms and revokes, the cosigner pre-clears and panics, the owner changes the rules.</p>`;
  const r = [same(S.account, g.hot) && "HOT", same(S.account, g.cosigner) && "cosigner", same(S.account, g.owner) && "owner"].filter(Boolean);
  if (!r.length) return `<p class="muted small">Your wallet account ${short(S.account)} has no role in this guard; you can top up reserves. To arm, switch your wallet to HOT ${short(g.hot)}.</p>`;
  return "";
}

function chainCard(ch) {
  const g = S.guard;
  const st = chainState(ch);
  const n = S.nets[ch.id] || {};
  const head = `<header>${chip(ch.id)} <b>${esc(net(ch.id).name)}</b> <span class="pill ${st.cls}">${st.label}</span></header>`;
  if (!ch.known) return `<div class="card" data-chain="${ch.id}">${head}<p class="muted">This guard protects chain ${ch.id}, which ${esc(CFG_FILE)} has no RPC for.</p></div>`;
  if (ch.err) return `<div class="card" data-chain="${ch.id}">${head}<p class="bad-t small">${esc(ch.err)}</p></div>`;
  const hasG = ch.guardian !== ZERO;
  const steps = [];
  const tick = (ok) => (ok ? `<span class="tick ok-t">✓</span>` : `<span class="tick warn-t">○</span>`);
  // 1. Guardian
  if (!hasG) {
    if (ch.pending) {
      steps.push(`<li>${tick(false)}<div class="what">Point Tripwire at your new Guardian ${link(ch.id, "address", ch.pending)} <span class="who">owner</span>${youAre("owner")}</div><button data-act="setPending">Connect it</button></li>`);
    } else {
      steps.push(`<li>${tick(false)}<div class="what">Deploy a Guardian here and point Tripwire at it <span class="who">any account, then owner</span>
        <div class="row small muted" style="margin-top:4px"><label class="fld" style="flex:0 1 160px">Callback reserves (${esc(nativeSym(ch.id))})<input id="fund-${ch.id}" value="${esc(defaultGuardianFund())}" inputmode="decimal"></label></div>
        <details style="margin-top:6px"><summary>Use a Guardian that already exists</summary><div class="row" style="margin-top:6px"><input id="use-g-${ch.id}" class="addr-in" style="flex:1 1 220px" placeholder="0x… Guardian on ${esc(net(ch.id).short)}"><button data-act="useGuardian">Check and use</button></div></details></div>
        <button class="primary" data-act="deployGuardian">Deploy</button></li>`);
    }
  } else {
    steps.push(`<li>${tick(!ch.issues.length)}<div class="what">Guardian ${link(ch.id, "address", ch.guardian, ch.guardian)}${ch.issues.map((x) => `<div class="bad-t small">${esc(x)}</div>`).join("")}
      <div class="small muted">Callback reserves ${ch.reserves != null ? `${fmt(ch.reserves)} ${esc(nativeSym(ch.id))}` : "–"}${ch.debt ? ` · <span class="bad-t">debt ${fmt(ch.debt)}</span>` : ch.debt === 0n ? " · no debt" : ""}</div></div></li>`);
  }
  // 2. Tokens
  if (!ch.tokens.length) steps.push(`<li>${tick(false)}<div class="what">Watch at least one token here <span class="who">owner</span>${youAre("owner")}<div class="small muted">Under Rules → Watch a token.</div></div></li>`);
  // 3. Panic / pre-clear contracts
  const sigOk = ch.intentOk && ch.panicOk;
  if (!sigOk) {
    const can = (!ch.intentOk && same(ch.intent, signalAddr(CONTRACTS.Intent.bytecode))) || (!ch.panicOk && same(ch.panic, signalAddr(CONTRACTS.PanicButton.bytecode)));
    steps.push(`<li>${tick(false)}<div class="what">${!ch.intentOk ? "Intent" : ""}${!ch.intentOk && !ch.panicOk ? " and " : ""}${!ch.panicOk ? "PanicButton" : ""} ${ch.intent === ZERO && ch.panic === ZERO ? "not configured" : "not deployed"} here: no ${!ch.intentOk ? "pre-clearing" : ""}${!ch.intentOk && !ch.panicOk ? " or " : ""}${!ch.panicOk ? "panic" : ""} on this chain.</div>${can ? `<button data-act="deploySignals">Deploy</button>` : ""}</li>`);
  }
  const missing = ch.tokens.filter((t) => !t.armed && !t.missing);
  const toks = ch.tokens.map((t) => `<div class="tok">
      <div class="sym" title="${esc(t.address)}">${esc(t.symbol)}</div>
      <div class="nums">${t.missing ? `<span class="bad-t">no contract at ${short(t.address)} on this chain</span>` : `HOT <b>${fmt(t.balance, t.decimals)}</b> · COLD ${fmt(t.coldBalance, t.decimals)} · threshold ${t.threshold ? fmt(t.threshold, t.decimals) : "0"}`}</div>
      <div>${t.missing ? "" : t.armed ? `<span class="pill p-ok">approved</span>` : hasG ? `<span class="pill p-warn">${t.allowance > 0n ? "approval too low" : "not approved"}</span>` : `<span class="pill p-muted">waits for Guardian</span>`}</div>
    </div>`).join("");
  const arm = hasG && !ch.issues.length && missing.length
    ? `<div class="row" style="margin-top:8px"><button class="primary" data-act="armChain">Arm ${esc(net(ch.id).short)}: ${missing.length} approval${missing.length > 1 ? "s" : ""}</button><span class="who">HOT</span>${youAre("HOT")}</div>` : "";
  const left = ch.leftovers?.length
    ? `<div class="callout" style="margin-top:8px">${ch.leftovers.length} approval${ch.leftovers.length > 1 ? "s" : ""} left on an old Guardian (${ch.leftovers.map((l) => esc(l.token.symbol)).join(", ")}). Tripwire no longer calls it, but revoke them anyway. <button data-act="revokeLeft">Revoke</button> <span class="who">HOT</span>${youAre("HOT")}</div>` : "";
  const disarm = hasG && !ch.issues.length ? `<details style="margin-top:10px"><summary>Disarm this chain</summary><p class="small">The owner first tells Tripwire to stop sweeping here, then HOT revokes the Guardian's approvals. In the other order, the first revoke looks like a thief cutting the guard and sweeps everything to COLD (safe, but probably not what you want).</p><button data-act="disarm">Disarm ${esc(net(ch.id).short)}…</button></details>` : "";
  return `<div class="card ${st.armed ? "armed" : "unarmed"}" data-chain="${ch.id}">${head}
    <ul class="steps">${steps.join("")}</ul>
    ${ch.tokens.length ? `<div style="margin-top:6px">${toks}</div>` : ""}
    ${arm}${left}${disarm}
  </div>`;
}

function chainsPanel() {
  const g = S.guard;
  const todo = setupSteps();
  return `<section class="panel">
    <h2>Chains <span class="muted small">protected by this guard, fixed at deploy</span>
      <span class="spacer"></span>${todo.length ? `<button class="primary" data-act="armAll" id="arm-all">Finish setup: ${todo.length} transaction${todo.length > 1 ? "s" : ""}</button>` : ""}
      <button class="ghost" data-act="refresh" title="Read the chains again">↻</button></h2>
    <div class="chains">${g.chains.map(chainCard).join("")}</div>
  </section>`;
}

function actionsPanel() {
  const g = S.guard;
  const panicChains = g.chains.filter((c) => c.known && c.panicOk);
  const intentChains = g.chains.filter((c) => c.known && c.intentOk);
  const isHot = same(S.account, g.hot), isCos = same(S.account, g.cosigner), isOwner = same(S.account, g.owner);
  const tokOpts = (chs) => chs.flatMap((c) => c.tokens.filter((t) => !t.missing).map((t) => `<option value="${c.id}:${t.address}">${esc(net(c.id).short)} · ${esc(t.symbol)}</option>`)).join("");
  const sugg = Object.entries(USDC).filter(([id]) => g.chains.some((c) => c.id === Number(id))).map(([id, a]) => `<option value="${a}">USDC on ${esc(net(Number(id)).short)}</option>`).join("");
  const trustedList = S.history?.trusted || [];
  return `<section class="panel" id="panic-panel">
    <h2><span class="bad-t">Panic</span> <span class="muted small">sweep everything to COLD, on every chain, now</span></h2>
    ${panicChains.length ? `<div class="panic-box">
      <label class="fld">Press it on<select id="panic-chain">${panicChains.map((c) => `<option value="${c.id}">${esc(net(c.id).name)}</option>`).join("")}</select></label>
      <button class="danger big" data-act="panic" id="panic-btn" ${S.account && !isHot && !isCos ? "disabled" : ""}>Panic</button>
      <div class="small muted" style="flex:1 1 240px">From the cosigner${youAre("cosigner")} it always fires. From HOT${youAre("HOT")} it fires unless a trip happened in the last ${dur(g.cooldown)}. Anyone else's press is ignored by Tripwire.</div>
    </div>` : `<p class="muted">No PanicButton is deployed on the chains this guard protects.</p>`}
  </section>
  <section class="panel" id="preclear-panel">
    <h2>Pre-clear a payment <span class="who">cosigner</span>${youAre("cosigner")}</h2>
    <p class="muted small">A planned payment from HOT to a new address would trip. Pre-clear it from the cosigner first, wait until it shows below, then send it.</p>
    ${intentChains.length ? `<div class="grid">
      <label class="fld">Token<select id="pc-token">${tokOpts(intentChains)}</select></label>
      <label class="fld">Recipient (or spender)<input id="pc-to" class="addr-in" placeholder="0x…" spellcheck="false"></label>
      <label class="fld">Up to (amount)<input id="pc-amount" inputmode="decimal" placeholder="e.g. 25"></label>
      <label class="fld">For (minutes, max 1440)<input id="pc-mins" inputmode="numeric" value="15"></label>
    </div>
    <div class="row" style="margin-top:10px"><button data-act="preclear" id="pc-btn" ${S.account && !isCos ? "disabled" : ""}>Pre-clear</button>${S.account && !isCos ? `<span class="muted small">Switch your wallet to the cosigner ${short(g.cosigner)}.</span>` : ""}</div>` : `<p class="muted">No Intent contract is deployed on the chains this guard protects.</p>`}
    ${intentsList()}
  </section>
  <section class="panel" id="rules-panel">
    <h2>Rules <span class="who">owner</span>${youAre("owner")}</h2>
    ${S.account && !isOwner ? `<p class="muted small">Only the owner ${short(g.owner)} can change these.</p>` : ""}
    <h3>Watch a token</h3>
    <div class="grid">
      <label class="fld">Chain<select id="ow-chain">${g.chains.filter((c) => c.known).map((c) => `<option value="${c.id}">${esc(net(c.id).name)}</option>`).join("")}</select></label>
      <label class="fld">Token address<input id="ow-token" class="addr-in" list="ow-sugg" placeholder="0x…" spellcheck="false"><datalist id="ow-sugg">${sugg}</datalist></label>
      <label class="fld">Never trip below (amount)<input id="ow-th" inputmode="decimal" value="0"></label>
    </div>
    <div class="row" style="margin-top:8px"><button data-act="ownerAddToken" id="ow-add">Watch it</button><span class="muted small">If the Guardian is set, HOT's approval for it follows as a second step.</span></div>
    ${g.chains.some((c) => c.tokens.length) ? `<h3>Threshold, or stop watching</h3>
    <div class="grid">
      <label class="fld">Token<select id="ow-tok2">${tokOpts(g.chains)}</select></label>
      <label class="fld">New threshold (amount)<input id="ow-th2" inputmode="decimal" placeholder="e.g. 5"></label>
    </div>
    <div class="row" style="margin-top:8px"><button data-act="ownerThreshold">Set threshold</button><button data-act="ownerRemoveToken">Stop watching</button></div>` : ""}
    <h3>Trusted addresses <span class="muted small">moves to them never trip</span></h3>
    ${trustedList.length ? `<ul class="list">${trustedList.map((a) => `<li class="row"><span class="addr">${esc(a)}</span><span class="spacer"></span><button data-act="ownerTrust" data-on="0" data-addr="${esc(a)}">Untrust</button></li>`).join("")}</ul>` : `<p class="muted small">None set in the last ${S.history?.hours ?? "few"} h.</p>`}
    <div class="row" style="margin-top:6px"><input id="ow-trust" class="addr-in" style="flex:1 1 280px" placeholder="0x… exchange deposit, pool you swap through" spellcheck="false"><button data-act="ownerTrust" data-on="1">Trust</button><button data-act="ownerTrust" data-on="0">Untrust</button></div>
    <h3>Merge window</h3>
    <div class="row"><input id="ow-cd" inputmode="numeric" style="width:120px" value="${g.cooldown}"><span class="muted small">seconds (0 to 86400)</span><button data-act="ownerCooldown">Set</button></div>
    <details style="margin-top:12px"><summary>Hand over ownership</summary><div class="row" style="margin-top:6px"><input id="ow-owner" class="addr-in" style="flex:1 1 280px" placeholder="0x… new owner (the cosigner is a good choice)" spellcheck="false"><button data-act="ownerTransfer">Transfer</button></div></details>
  </section>
  <section class="panel" id="topup-panel">
    <h2>Reserves <span class="who">any account</span></h2>
    <p class="muted small">Reactive Network bills Tripwire for reactions and each Guardian for the sweeps delivered to it. Either one in debt goes silent.</p>
    <div class="row">
      <select id="tu-target"><option value="tw">Tripwire on ${esc(net(S.rid).short || R())}</option>${g.chains.filter((c) => c.known && c.guardian !== ZERO).map((c) => `<option value="g:${c.id}">Guardian on ${esc(net(c.id).short)}</option>`).join("")}</select>
      <input id="tu-amount" inputmode="decimal" style="width:120px" placeholder="amount">
      <button data-act="topUp">Top up</button>
      ${g.sysDebt > 0n ? `<button data-act="coverDebt">Settle Tripwire's debt from its balance</button>` : ""}
    </div>
  </section>`;
}

function intentsList() {
  const list = S.history?.intents || [];
  if (!list.length) return "";
  const meta = (id, a) => S.guard.chains.find((c) => c.id === Number(id))?.tokens.find((t) => same(t.address, a)) || { symbol: short(a), decimals: 18 };
  return `<h3>Pre-cleared payments</h3><ul class="list" id="intents">${list.map((x) => {
    const t = meta(x.chainId, x.token);
    return `<li>${chip(Number(x.chainId))} up to <b>${fmt(x.left, t.decimals)} ${esc(t.symbol)}</b> to <span class="addr">${esc(x.to)}</span> · ends ${ago(x.liveExpiry)}</li>`;
  }).join("")}</ul>`;
}

function historyPanel() {
  const h = S.history;
  const g = S.guard;
  if (S.histErr) return `<section class="panel"><h2>History</h2><p class="bad-t small">Couldn't read the history: ${esc(S.histErr)}</p></section>`;
  if (!h) return `<section class="panel"><h2>History</h2><p class="muted">Reading…</p></section>`;
  const tokenSym = (id, a) => g.chains.find((c) => c.id === id)?.tokens.find((t) => same(t.address, a)) || { symbol: short(a), decimals: 18 };
  const trips = h.trips.map((t) => {
    // With the trip's events in the window, list the chains it asked to sweep; without, what each Guardian says.
    const dests = t.reason ? g.chains.filter((c) => t.sweeps[c.id]?.requested) : g.chains.filter((c) => t.sweeps[c.id]?.done != null);
    const allDone = dests.length > 0 && dests.every((c) => t.sweeps[c.id]?.done);
    const sweeps = dests.map((c) => {
      const s = t.sweeps[c.id] || {};
      const moved = (s.moved || []).map((m) => { const k = tokenSym(c.id, m.token); return `${fmt(m.amount, k.decimals)} ${esc(k.symbol)}`; }).join(", ");
      const what = s.done
        ? `<span class="ok-t">swept to COLD</span>${moved ? ` · ${moved}` : s.swept === 0 ? " · nothing left to move" : ""}${s.tx ? ` · ${link(c.id, "tx", s.tx)}` : ""}`
        : s.done === false ? (t.reason ? `<span class="warn-t">requested, not landed yet</span>` : `<span class="muted">no sweep recorded by the current Guardian</span>`) : `<span class="muted">Guardian not readable</span>`;
      return `<div class="row small">${chip(c.id)} ${what}</div>`;
    }).join("") || (t.reason ? `<div class="small muted">No chain had a Guardian and tokens, so nothing was swept.</div>` : "");
    return `<div class="trip ${allDone ? "done" : ""}" data-trip="${t.id}">
      <div class="row"><b>Trip #${t.id}</b>${t.reason ? ` · ${esc(REASON_TEXT[t.reason] || t.reason)} on ${chip(t.chainId)}` : ""}${t.at ? ` · <span class="muted">${ago(t.at)}</span>` : ""}${t.tx ? ` · ${link(S.rid, "tx", t.tx)}` : ""}
        ${t.merged.length ? `<span class="pill p-muted">${t.merged.length} merged move${t.merged.length > 1 ? "s" : ""}</span>` : ""}</div>
      ${sweeps}
    </div>`;
  }).join("");
  const changes = h.changes.map((l) => `<li><span class="muted small">${esc(l.eventName)}</span> ${esc(changeText(l))} · ${link(S.rid, "tx", l.transactionHash)}</li>`).join("");
  return `<section class="panel" id="history">
    <h2>History <span class="muted small">trips: all ${g.trips} by id; details from the last ${h.hours} h of ${esc(R())}${h.partial ? " (partly)" : ""}</span></h2>
    ${trips || `<p class="muted">No trips yet. When one happens it shows here with each chain's sweep.</p>`}
    ${changes ? `<details><summary>Rule changes in that window</summary><ul class="list">${changes}</ul></details>` : ""}
  </section>`;
}

function changeText(l) {
  const a = l.args;
  switch (l.eventName) {
    case "GuardianSet": return `${net(Number(a.chainId)).short}: ${a.guardian === ZERO ? "Guardian removed" : "Guardian " + short(a.guardian)}`;
    case "TrustedSet": return `${short(a.account)} ${a.trusted ? "trusted" : "untrusted"}`;
    case "TokenAdded": return `${net(Number(a.chainId)).short}: watching ${short(a.token)}`;
    case "TokenRemoved": return `${net(Number(a.chainId)).short}: stopped watching ${short(a.token)}`;
    case "ThresholdSet": return `${net(Number(a.chainId)).short}: threshold of ${short(a.token)} = ${a.threshold}`;
    case "TripCooldownSet": return `merge window ${dur(Number(a.cooldown))}`;
    case "OwnerSet": return `owner ${short(a.owner)}`;
    default: return "";
  }
}

function wizardPanel() {
  const ids = destIds();
  const suggestions = (id) => {
    const out = [];
    if (USDC[id]) out.push([USDC[id], "USDC"]);
    for (const t of S.nets[id].tokens || []) out.push(typeof t === "string" ? [t, short(t)] : [t.address, t.symbol || short(t.address)]);
    return out;
  };
  return `<section class="panel" id="wizard">
    <h2>Set up a new guard</h2>
    <p>Three addresses decide everything, and they can't change later:</p>
    <div class="grid">
      <label class="fld">HOT: the wallet you use every day, to protect<input id="nw-hot" class="addr-in" value="${esc(S.account || "")}" placeholder="0x…" spellcheck="false"></label>
      <label class="fld">COLD: where everything goes on a trip (hardware wallet, safe)<input id="nw-cold" class="addr-in" placeholder="0x…" spellcheck="false"></label>
      <label class="fld">Cosigner: a second key (phone wallet) for pre-clears and panic<input id="nw-cos" class="addr-in" placeholder="0x…" spellcheck="false"></label>
    </div>
    <h3>Chains to protect</h3>
    ${ids.length ? ids.map((id) => `<div class="card" style="margin-bottom:8px">
      <label class="chk"><input type="checkbox" id="nw-c-${id}" checked> ${chip(id)} ${esc(net(id).name)}</label>
      <div class="row small" style="margin-top:6px"><span class="muted">Tokens to guard:</span>
        ${suggestions(id).map(([a, s]) => `<label class="chk"><input type="checkbox" data-nwtok="${id}" value="${esc(a)}"> ${esc(s)}</label>`).join("")}
        <input id="nw-t-${id}" class="addr-in" style="flex:1 1 220px" placeholder="more token addresses, comma separated" spellcheck="false"></div>
    </div>`).join("") : `<p class="bad-t">${esc(CFG_FILE)} lists no chain with a callback proxy.</p>`}
    <div class="grid" style="margin-top:8px">
      <label class="fld">Fund Tripwire with (${esc(nativeSym(S.rid))}, pays for reactions)<input id="nw-fund" inputmode="decimal" value="${esc(defaultReactiveFund())}"></label>
      <label class="fld">Each Guardian's callback reserves (native gas of its chain)<input id="nw-gfund" inputmode="decimal" value="${esc(defaultGuardianFund())}"></label>
    </div>
    <div class="callout info">Send the setup from the cosigner or a separate key: that account becomes the owner, who can change the rules. HOT signs only the approvals at the end. Every transaction is explained before you sign it.</div>
    <div class="row"><button class="primary" data-act="wizardReview" id="nw-go">Review the transactions</button></div>
    <div id="nw-out"></div>
  </section>`;
}

function render() {
  if (!S.cfg) return;
  $("#header").innerHTML = header();
  const main = $("#main");
  // Keep what the user typed across re-renders.
  const keep = {};
  for (const el of $$("input[id], select[id]", main)) if (el.dataset.dirty) keep[el.id] = el.type === "checkbox" ? el.checked : el.value;
  for (const el of $$("input[data-nwtok]", main)) keep["tok:" + el.dataset.nwtok + ":" + el.value] = el.checked;
  const openDetails = $$("details", main).map((d, i) => d.open && (d.closest("[data-chain]")?.dataset.chain || "") + ":" + d.querySelector("summary")?.textContent).filter(Boolean);
  const focus = document.activeElement?.id;

  let html = guardPicker();
  if (S.view === "new") html += wizardPanel();
  else if (S.guardErr) {
    html += `<section class="panel"><div class="callout ${S.guardErr.notDeployed ? "" : "bad"}">${esc(S.guardErr.message || errText(S.guardErr))}${S.guardErr.notDeployed ? ` Check the address and the network (${esc(R())}), or set up a new guard.` : ""}</div></section>`;
  } else if (!S.guard) html += S.twAddr ? `<section class="panel muted">Reading your guard from ${esc(R())}…</section>` : wizardPanel();
  else html += summary() + chainsPanel() + actionsPanel() + historyPanel();
  main.innerHTML = html;

  for (const [id, v] of Object.entries(keep)) {
    if (id.startsWith("tok:")) {
      const [, cid, a] = id.split(":");
      const el = $(`input[data-nwtok="${cid}"][value="${a}"]`, main);
      if (el) el.checked = v;
      continue;
    }
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = v;
    else el.value = v;
    el.dataset.dirty = "1";
  }
  for (const d of $$("details", main)) if (openDetails.includes((d.closest("[data-chain]")?.dataset.chain || "") + ":" + d.querySelector("summary")?.textContent)) d.open = true;
  if (focus) document.getElementById(focus)?.focus();
}

let toastT;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.style.display = "block";
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.style.display = "none"), 5000);
}

// ------------------------------------------------------------------ boot

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el || el.disabled) return;
  const f = ACT[el.dataset.act];
  if (f) {
    e.preventDefault();
    Promise.resolve(f(el)).catch((err) => toast(friendly(err)));
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id) e.target.dataset.dirty = "1";
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.id === "tw-in") ACT.loadGuard();
  if (e.key === "Escape" && $("#modal").classList.contains("open") && !S.running) $("#plan-cancel")?.click();
});

(async function boot() {
  try {
    const th = localStorage.getItem("tripwire-arm:theme");
    if (th) document.documentElement.dataset.theme = th;
  } catch {}
  try {
    await loadConfig();
  } catch (e) {
    $("#main").innerHTML = `<section class="panel"><div class="callout bad">${esc(errText(e))}</div></section>`;
    return;
  }
  document.title = S.mainnet ? "Tripwire Arm (mainnet)" : "Tripwire Arm";
  hookWallet();
  render();
  await refresh({ history: true });
  // Keep the state current: every 20 s, every 3 s for two minutes after a panic or pre-clear.
  let last = Date.now();
  setInterval(() => {
    if (document.hidden || S.running || !S.twAddr) return;
    const fast = Date.now() < S.fastUntil;
    if (Date.now() - last < (fast ? 3000 : 20000)) return;
    last = Date.now();
    refresh({ history: fast });
  }, 1000);
})();
