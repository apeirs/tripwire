#!/usr/bin/env node
// Drives demo/arm/ in headless Chromium against local anvils (started by e2e.sh) and checks every flow on chain.
// The wallet is an injected EIP-1193 provider that forwards to the anvil of the selected chain and sends from an
// unlocked anvil dev account; the test switches accounts the way a user does in their wallet.
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const shots = resolve(here, "../shots");
mkdirSync(shots, { recursive: true });
const E = process.env;
const RPC = { 84532: E.E2E_BASE, 1301: E.E2E_UNI, 5318007: E.E2E_LASNA };
const ACC = E.E2E_ACCOUNTS.split(",");
const TOKENS = E.E2E_TOKENS.split(",");
const URL0 = `${E.E2E_HTTP}/arm/?config=${E.E2E_CONFIG}`;
const MAXU = (1n << 256n) - 1n;

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  for (const c of [E.PLAYWRIGHT_DIR, "playwright", "/home/a/apeir-online/browser/node_modules/playwright"].filter(Boolean)) {
    try {
      return req(c);
    } catch {}
  }
  throw new Error("Playwright not found; set PLAYWRIGHT_DIR");
}
const { chromium } = loadPlaywright();
const pwCache = `${E.HOME}/.cache/ms-playwright`;
const exe = [E.CHROMIUM, ...(existsSync(pwCache) ? readdirSync(pwCache) : []).filter((d) => d.startsWith("chromium-")).map((d) => `${pwCache}/${d}/chrome-linux/chrome`)].find((p) => p && existsSync(p));

// ------------------------------------------------------------------ chain helpers (cast for reads, raw RPC for sends)

let failed = 0;
function check(desc, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${desc}${extra ? ` (${extra})` : ""}`);
  if (!ok) failed++;
}
const cast = (...a) => execFileSync("cast", a, { encoding: "utf8" }).trim().split(" ")[0];
const call = (chain, to, sig, ...args) => cast("call", to, sig, ...args, "--rpc-url", RPC[chain]);
const big = (s) => BigInt(s);
let rid = 0;
async function rpc(chain, method, params = []) {
  const r = await fetch(RPC[chain], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rid, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
async function send(chain, from, to, sig, ...args) {
  const data = cast("calldata", sig, ...args);
  const hash = await rpc(chain, "eth_sendTransaction", [{ from, to, data }]);
  for (let i = 0; i < 100; i++) {
    const rc = await rpc(chain, "eth_getTransactionReceipt", [hash]);
    if (rc) return rc;
    await sleep(50);
  }
  throw new Error("no receipt");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(desc, fn, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {}
    if (Date.now() - t0 > ms) {
      check(`${desc} (timed out after ${ms / 1000} s)`, false);
      return false;
    }
    await sleep(300);
  }
}
const bal = (chain, token, who) => big(call(chain, token, "balanceOf(address)(uint256)", who));
const allow = (chain, token, owner, spender) => big(call(chain, token, "allowance(address,address)(uint256)", owner, spender));
function forge(script, chain, env) {
  const out = execFileSync("forge", ["script", script, "--rpc-url", RPC[chain], "--broadcast"], { cwd: root, encoding: "utf8", env: { ...E, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  return out;
}
const relays = [];
function startRelay(tw) {
  const p = spawn("node", ["tools/localnet/relay.mjs", "--lasna", RPC[5318007], "--chain", `84532=${RPC[84532]}`, "--chain", `1301=${RPC[1301]}`, "--tripwire", tw, "--poll", "200"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.stdout.write("    relay: " + d));
  relays.push(p);
  return p;
}

// ------------------------------------------------------------------ the injected wallet

function shim({ rpcs, account, chainId }) {
  const listeners = {};
  let acct = account;
  let chain = chainId;
  let connected = false;
  let n = 0;
  const emit = (ev, v) => (listeners[ev] || []).forEach((f) => { try { f(v); } catch {} });
  async function forward(method, params) {
    const r = await fetch(rpcs[chain], { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
    const j = await r.json();
    if (j.error) {
      const e = new Error(j.error.message);
      e.code = j.error.code;
      e.data = j.error.data;
      throw e;
    }
    return j.result;
  }
  window.__shim = {
    sent: [],
    switches: [],
    setAccount(a) {
      acct = a;
      emit("accountsChanged", [a]);
    },
  };
  window.ethereum = {
    on(ev, f) { (listeners[ev] ||= []).push(f); },
    removeListener(ev, f) { listeners[ev] = (listeners[ev] || []).filter((x) => x !== f); },
    async request({ method, params = [] }) {
      switch (method) {
        case "eth_requestAccounts":
          connected = true;
          return [acct];
        case "eth_accounts": return connected ? [acct] : []; // like a real wallet: nothing until the site connects
        case "eth_chainId": return "0x" + chain.toString(16);
        case "net_version": return String(chain);
        case "wallet_switchEthereumChain": {
          const c = parseInt(params[0].chainId, 16);
          if (!rpcs[c]) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
          if (c !== chain) {
            chain = c;
            window.__shim.switches.push(c);
            emit("chainChanged", "0x" + c.toString(16));
          }
          return null;
        }
        case "wallet_addEthereumChain": return null;
        case "eth_sendTransaction": {
          const tx = params[0];
          if (tx.from.toLowerCase() !== acct.toLowerCase()) throw Object.assign(new Error("from is not the selected account"), { code: 4100 });
          window.__shim.sent.push({ chain, from: tx.from, to: tx.to || null });
          return forward(method, params);
        }
        default: return forward(method, params);
      }
    },
  };
}

const browser = await chromium.launch({ executablePath: exe });
const errors = [];
async function openPage(account, query = "", { phone = false, colorScheme = "dark" } = {}) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme }
    : { viewport: { width: 1280, height: 900 }, colorScheme });
  await ctx.addInitScript(shim, { rpcs: RPC, account, chainId: 84532 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto(URL0 + query);
  await page.waitForSelector("#main .panel");
  return page;
}
async function shot(page, name, { full = true } = {}) {
  const f = `${shots}/${name}.png`;
  await page.screenshot({ path: f, fullPage: full });
  // html/body clip horizontally, so measure what sticks out instead of the scroll width.
  const over = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const out = [...document.querySelectorAll("body *")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width && r.right > w + 1 && !el.closest("#modal:not(.open)");
    });
    return { scroll: document.documentElement.scrollWidth - window.innerWidth, out: out.slice(0, 3).map((el) => el.tagName + "." + el.className + " " + Math.round(el.getBoundingClientRect().right)) };
  });
  check(`${name}: nothing wider than the viewport`, over.scroll <= 0 && !over.out.length, JSON.stringify(over));
  console.log(`    shot ${f}`);
}
const setAccount = (page, a) => page.evaluate((x) => window.__shim.setAccount(x), a);
// Opens the plan dialog's "Sign" and waits for the end, switching accounts when a step asks for another signer.
async function confirmPlan(page, signers = {}, { beforeSign } = {}) {
  await page.waitForSelector("#plan-go", { timeout: 30000 });
  if (beforeSign) await beforeSign();
  await page.click("#plan-go");
  for (;;) {
    const st = await page.evaluate(() => {
      const m = document.querySelector("#plan-msg");
      const wait = [...document.querySelectorAll("#plan-steps .st")].map((x) => x.textContent).find((t) => /must be signed by the/.test(t));
      return { msg: m?.textContent || "", wait };
    });
    if (st.msg) return st.msg;
    if (st.wait) {
      const role = Object.keys(signers).find((r) => st.wait.includes(`by the ${r} `));
      if (!role) return "stuck waiting: " + st.wait;
      await setAccount(page, signers[role]);
    }
    await sleep(250);
  }
}
const closePlan = (page) => page.click("#plan-cancel");
async function waitText(page, sel, re, ms = 30000) {
  try {
    await page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent || ""), [sel, re], { timeout: ms });
  } catch (e) {
    console.log(`    page ${sel} text was: ${(await page.textContent(sel).catch(() => "?"))?.replace(/\s+/g, " ").slice(0, 600)}`);
    throw e;
  }
}

try {
  // ---------------------------------------------------------------- 0. not deployed (the real configs, no RPC call)
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
    const p = await ctx.newPage();
    const external = [];
    p.on("request", (r) => { const u = r.url(); if (!u.startsWith(E.E2E_HTTP) && !u.startsWith("https://cdn.jsdelivr.net/npm/")) external.push(u); });
    p.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    for (const net of ["testnet", "mainnet"]) {
      await p.goto(`${E.E2E_HTTP}/arm/?net=${net}`);
      await p.waitForSelector("#wizard");
      const txt = await p.textContent("#main");
      check(`${net} config: "No Tripwire deployed yet" state`, /No Tripwire deployed yet/.test(txt));
      if (net === "mainnet") check("mainnet: real-funds pill in the header", /Mainnet/.test(await p.textContent("#header")));
      await shot(p, `00-${net}-not-deployed`);
    }
    check("not-deployed state reads no chain (only the page and the viem CDN)", external.length === 0, external.join(" "));
    await ctx.close();
  }

  // ---------------------------------------------------------------- 1. Guard B: a new guard, entirely from the page
  console.log("== guard B: set up from the page (owner = cosigner 7, HOT 5, COLD 6)");
  const [HOT_B, COLD_B, COS_B] = [ACC[5], ACC[6], ACC[7]];
  for (const c of [84532, 1301]) for (const t of TOKENS) await send(c, ACC[0], t, "mint(address,uint256)", HOT_B, "1000000000000000000000");
  let page = await openPage(COS_B);
  await page.click("#connect");
  await page.fill("#nw-hot", HOT_B);
  await page.fill("#nw-cold", COLD_B);
  await page.fill("#nw-cos", COS_B);
  await page.fill("#nw-t-84532", TOKENS.join(","));
  await page.fill("#nw-t-1301", TOKENS.join(","));
  await shot(page, "01-new-guard-form");
  const phoneNew = await openPage(COS_B, "", { phone: true });
  await phoneNew.fill("#nw-cold", COLD_B);
  await shot(phoneNew, "01-new-guard-form-phone");
  await phoneNew.context().close();
  await page.click("#nw-go");
  await page.waitForSelector("#plan-go", { timeout: 30000 });
  const nSteps = await page.locator("#plan-steps .tx").count();
  // 2 signals on Unichain + Tripwire + 2 × (Guardian, reserves, setGuardian, 3 × addToken) + 6 approvals
  check("review lists every transaction (2 + 1 + 12 + 6 = 21)", nSteps === 21, `${nSteps}`);
  const explained = await page.evaluate(() => [...document.querySelectorAll("#plan-steps .tx")].every((x) => x.querySelectorAll("li").length > 0));
  check("every transaction carries a plain-words explanation", explained);
  await shot(page, "02-review-transactions", { full: false });
  const phoneDlg = await openPage(COS_B, "", { phone: true });
  await phoneDlg.fill("#nw-hot", HOT_B);
  await phoneDlg.fill("#nw-cold", COLD_B);
  await phoneDlg.fill("#nw-cos", COS_B);
  await phoneDlg.fill("#nw-t-84532", TOKENS.join(","));
  await phoneDlg.click("#nw-go");
  await phoneDlg.waitForSelector("#plan-go", { timeout: 30000 });
  await shot(phoneDlg, "02-review-transactions-phone", { full: false });
  await phoneDlg.context().close();

  let msg = await confirmPlan(page, { HOT: HOT_B });
  check("guard B setup ran to the end", /armed/.test(msg), msg);
  const TW_B = await page.evaluate(() => localStorage.getItem("tripwire-arm:5318007:tripwire")).then((x) => JSON.parse(x));
  check("guard B address remembered by the page", /^0x[0-9a-fA-F]{40}$/.test(TW_B || ""), TW_B);
  const intentU = call(1301, E.E2E_INTENT, "MAX_TTL()(uint64)");
  check("page deployed Intent on Unichain at the CREATE2 address (same as Base)", intentU === "86400");
  check("page deployed PanicButton on Unichain", (await rpc(1301, "eth_getCode", [E.E2E_PANIC, "latest"])).length > 2);
  check("guard B: HOT/COLD/cosigner/owner", same(call(5318007, TW_B, "HOT()(address)"), HOT_B) && same(call(5318007, TW_B, "COLD()(address)"), COLD_B) && same(call(5318007, TW_B, "COSIGNER()(address)"), COS_B) && same(call(5318007, TW_B, "owner()(address)"), COS_B));
  const G_B = {};
  for (const c of [84532, 1301]) {
    G_B[c] = cast("call", TW_B, "chainConfig(uint256)((address,address,address,address[]))", String(c), "--rpc-url", RPC[5318007]).slice(1, 43);
    const ok = TOKENS.every((t) => allow(c, t, HOT_B, G_B[c]) === MAXU);
    check(`guard B on ${c}: Guardian ${G_B[c]} set, 3 tokens watched, all approved max`, /^0x/.test(G_B[c]) && execFileSync("cast", ["call", TW_B, "tokens(uint256)(address[])", String(c), "--rpc-url", RPC[5318007]], { encoding: "utf8" }).split(",").length === 3 && ok);
    check(`guard B on ${c}: Guardian obeys guard B`, same(call(c, G_B[c], "_CALLBACK_SENDER()(address)"), TW_B));
  }
  await closePlan(page);
  await waitText(page, "#main", "armed on all 2 chains");
  check("page shows guard B armed on all 2 chains", true);
  await shot(page, "03-armed");

  console.log("== guard B: phishing approval from HOT → trip → sweep on both chains");
  let relay = startRelay(TW_B);
  await sleep(1200);
  await send(84532, HOT_B, TOKENS[0], "approve(address,uint256)", ACC[3], "1000");
  await until("guard B swept both chains", () => TOKENS.every((t) => bal(84532, t, HOT_B) === 0n && bal(1301, t, HOT_B) === 0n), 30000);
  check("guard B: COLD holds all 6 minted balances", [84532, 1301].every((c) => TOKENS.every((t) => bal(c, t, COLD_B) === 10n ** 21n)));
  check("guard B: trips() = 1", call(5318007, TW_B, "trips()(uint256)") === "1");
  await page.click('[data-act="refresh"]');
  await waitText(page, "#history", "Trip #1[\\s\\S]*approval");
  await page.waitForFunction(() => document.querySelectorAll('#history [data-trip="1"] .ok-t').length === 2, null, { timeout: 30000 });
  check("history: trip #1 (untrusted approval) swept on both chains", true);
  relay.kill();
  await page.context().close();

  // ---------------------------------------------------------------- 2. Guard A: deployed by the repo's scripts, armed and managed from the page
  console.log("== guard A: scripts deploy Tripwire, Guardians and tokens (owner 0, HOT 1, cosigner 2, COLD 4); no Arm script");
  const [OWNER, HOT, COS, ATT, COLD, PAYEE] = [ACC[0], ACC[1], ACC[2], ACC[3], ACC[4], ACC[8]];
  const env = { HOT, COLD, COSIGNER: COS };
  const TW = forge("script/DeployReactive.s.sol", 5318007, { ...env, CHAIN_IDS: "84532,1301", INTENTS: `${E.E2E_INTENT},${E.E2E_INTENT}`, PANICS: `${E.E2E_PANIC},${E.E2E_PANIC}`, FUND: "2ether" }).match(/TRIPWIRE=(0x[0-9a-fA-F]{40})/)[1];
  const G = {};
  for (const c of [84532, 1301]) G[c] = forge("script/DeployGuardian.s.sol", c, { ...env, TRIPWIRE: TW, FUND: "0.01ether" }).match(/GUARDIAN=(0x[0-9a-fA-F]{40})/)[1];
  for (const c of [84532, 1301]) forge("script/Configure.s.sol", 5318007, { TRIPWIRE: TW, CHAIN_ID: String(c), GUARDIAN: G[c], TOKENS: TOKENS.join(",") });
  console.log(`    TRIPWIRE=${TW} G_BASE=${G[84532]} G_UNI=${G[1301]}`);
  relay = startRelay(TW);

  page = await openPage(HOT, `&tripwire=${TW}`);
  await page.click("#connect");
  await waitText(page, "#main", "not armed yet");
  const fin = await page.textContent("#arm-all");
  check("page: not armed, 6 approvals to finish", /6 transactions/.test(fin), fin);
  await shot(page, "04-scripted-guard-not-armed");
  const phone = await openPage(HOT, `&tripwire=${TW}`, { phone: true });
  await waitText(phone, "#main", "not armed yet");
  await shot(phone, "04-scripted-guard-not-armed-phone");
  await phone.context().close();

  console.log("== arm Base from its card (HOT)");
  await page.click('[data-chain="84532"] [data-act="armChain"]');
  msg = await confirmPlan(page, {});
  check("arm Base: done", /armed/.test(msg), msg);
  check("Base: 3 allowances = max, Unichain still 0", TOKENS.every((t) => allow(84532, t, HOT, G[84532]) === MAXU) && TOKENS.every((t) => allow(1301, t, HOT, G[1301]) === 0n));
  await closePlan(page);
  console.log("== finish setup (Unichain approvals), switching chains in the wallet");
  await waitText(page, "#arm-all", "3 transactions");
  await page.click("#arm-all");
  msg = await confirmPlan(page, {});
  check("finish setup: done", /armed/.test(msg), msg);
  check("Unichain: 3 allowances = max", TOKENS.every((t) => allow(1301, t, HOT, G[1301]) === MAXU));
  check("wallet was asked to switch to Unichain", (await page.evaluate(() => window.__shim.switches)).includes(1301));
  await closePlan(page);
  await waitText(page, "#main", "armed on all 2 chains");
  check("page: armed on all 2 chains", true);
  await sleep(2000);
  check("arming caused no trip (max approvals to the Guardian clear)", call(5318007, TW, "trips()(uint256)") === "0");

  console.log("== pre-clear a payment (cosigner), then pay it from HOT: no trip");
  await setAccount(page, COS);
  await page.selectOption("#pc-token", `84532:${TOKENS[0]}`);
  await page.fill("#pc-to", PAYEE);
  await page.fill("#pc-amount", "50");
  await page.fill("#pc-mins", "15");
  await page.click("#pc-btn");
  msg = await confirmPlan(page, {});
  check("pre-clear sent", /done/i.test(msg), msg);
  await closePlan(page);
  await until("Tripwire stored the intent", async () => {
    const key = cast("call", TW, "intentKey(uint256,address,address)(bytes32)", "84532", TOKENS[0], PAYEE, "--rpc-url", RPC[5318007]);
    return big(cast("call", TW, "intents(bytes32)(uint128,uint64)", key, "--rpc-url", RPC[5318007])) === 50n * 10n ** 6n;
  });
  await page.click('[data-act="refresh"]');
  await waitText(page, "#preclear-panel", "up to 50 tUSD");
  check("page lists the pre-cleared payment", true);
  await send(84532, HOT, TOKENS[0], "transfer(address,uint256)", PAYEE, String(50n * 10n ** 6n));
  await sleep(2500);
  check("payment landed and did not trip (trips = 0, HOT keeps the rest)", bal(84532, TOKENS[0], PAYEE) === 50n * 10n ** 6n && call(5318007, TW, "trips()(uint256)") === "0" && bal(84532, TOKENS[0], HOT) === 950n * 10n ** 6n);

  console.log("== panic from the cosigner on Unichain → sweeps on both chains");
  await page.selectOption("#panic-chain", "1301");
  await page.click("#panic-btn");
  msg = await confirmPlan(page, {});
  check("panic sent", /Pressed/.test(msg), msg);
  await closePlan(page);
  await until("both chains swept to COLD", () => TOKENS.every((t) => bal(84532, t, HOT) === 0n && bal(1301, t, HOT) === 0n), 30000);
  check("COLD got everything left (950 tUSD on Base + 1000 of the rest)", bal(84532, TOKENS[0], COLD) === 950n * 10n ** 6n && bal(1301, TOKENS[1], COLD) === 1000n * 10n ** 18n);
  check("trips() = 1", call(5318007, TW, "trips()(uint256)") === "1");
  await page.waitForFunction(() => document.querySelectorAll('#history [data-trip="1"] .ok-t').length === 2, null, { timeout: 30000 });
  check("history: trip #1 (panic) swept on both chains, with amounts", /panic press/.test(await page.textContent("#history")) && /950 tUSD/.test(await page.textContent("#history")));
  await shot(page, "05-after-panic");
  const phone2 = await openPage(COS, `&tripwire=${TW}`, { phone: true });
  await phone2.click("#connect");
  await phone2.waitForSelector('#history [data-trip="1"]');
  await phone2.locator("#panic-panel").scrollIntoViewIfNeeded();
  await shot(phone2, "05-after-panic-phone");
  await phone2.context().close();
  const light = await openPage(COS, `&tripwire=${TW}`, { colorScheme: "light" });
  await light.waitForSelector('#history [data-trip="1"]');
  check("light theme follows the system setting", (await light.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(246, 247, 249)");
  await shot(light, "05-after-panic-light");
  await light.context().close();

  console.log("== rules (owner): trust an address, merge window, threshold");
  await setAccount(page, OWNER);
  await page.fill("#ow-trust", ATT);
  await page.click('#rules-panel [data-act="ownerTrust"][data-on="1"]:not([data-addr])');
  msg = await confirmPlan(page, {});
  check("trust: done", /done/i.test(msg), msg);
  await closePlan(page);
  check("trusted(attacker) = true on chain", call(5318007, TW, "trusted(address)(bool)", ATT) === "true");
  await page.fill("#ow-cd", "60");
  await page.click('[data-act="ownerCooldown"]');
  msg = await confirmPlan(page, {});
  check("tripCooldown = 60", call(5318007, TW, "tripCooldown()(uint64)") === "60", msg);
  await closePlan(page);
  await page.selectOption("#ow-tok2", `1301:${TOKENS[2]}`);
  await page.fill("#ow-th2", "5");
  await page.click('[data-act="ownerThreshold"]');
  msg = await confirmPlan(page, {});
  check("threshold(Unichain, token 3) = 5e18", call(5318007, TW, "threshold(uint256,address)(uint256)", "1301", TOKENS[2]) === String(5n * 10n ** 18n), msg);
  await closePlan(page);
  console.log("== a wrong signer is caught before signing (HOT tries an owner action)");
  await setAccount(page, HOT);
  await page.fill("#ow-cd", "120");
  const sentBefore = await page.evaluate(() => window.__shim.sent.length);
  await page.click('[data-act="ownerCooldown"]');
  await page.waitForSelector("#plan-go");
  await page.click("#plan-go");
  await waitText(page, "#plan-steps", "must be signed by the owner");
  await sleep(1000);
  check("owner-only step waits for the owner account instead of sending", (await page.evaluate(() => window.__shim.sent.length)) === sentBefore);
  await closePlan(page);
  await sleep(1500);
  check("nothing was sent for it (tripCooldown still 60)", call(5318007, TW, "tripCooldown()(uint64)") === "60");

  console.log("== top up a Guardian's callback reserves (any account)");
  const proxyU = "0x775c9B990ADe401060B78D0e98684eEf8d2466C1";
  const r0 = big(call(1301, proxyU, "reserves(address)(uint256)", G[1301]));
  await page.selectOption("#tu-target", "g:1301");
  await page.fill("#tu-amount", "0.02");
  await page.click('[data-act="topUp"]');
  msg = await confirmPlan(page, {});
  check("reserves of the Unichain Guardian +0.02", big(call(1301, proxyU, "reserves(address)(uint256)", G[1301])) - r0 === 2n * 10n ** 16n, msg);
  await closePlan(page);

  console.log("== disarm Base: owner first, then HOT revokes (no trip)");
  for (const t of TOKENS) await send(84532, ACC[0], t, "mint(address,uint256)", HOT, "1000000000000000000000");
  await setAccount(page, OWNER);
  await page.click('[data-act="refresh"]');
  await sleep(1500);
  await page.click('[data-chain="84532"] details summary');
  await page.click('[data-chain="84532"] [data-act="disarm"]');
  await page.waitForSelector("#plan-go");
  await shot(page, "06-disarm-review", { full: false });
  msg = await confirmPlan(page, { HOT, owner: OWNER });
  check("disarm: done", /disarmed/.test(msg), msg);
  await closePlan(page);
  await sleep(2500);
  check("Base: Guardian unset on Tripwire", /^\(0x0{40},/.test(cast("call", TW, "chainConfig(uint256)((address,address,address,address[]))", "84532", "--rpc-url", RPC[5318007])));
  check("Base: all approvals to the old Guardian are 0", TOKENS.every((t) => allow(84532, t, HOT, G[84532]) === 0n));
  check("revokes did not trip (trips still 1), HOT keeps its new Base tokens", call(5318007, TW, "trips()(uint256)") === "1" && TOKENS.every((t) => bal(84532, t, HOT) > 0n));
  await page.click('[data-act="refresh"]');
  await waitText(page, "#main", "armed on 1 of 2 chains");
  check("page: armed on 1 of 2 chains, Base shows no Guardian", /no Guardian/.test(await page.textContent('[data-chain="84532"]')));
  await shot(page, "07-after-disarm");

  console.log("== re-arm Base from the page: deploy a new Guardian, fund it, point Tripwire at it, approve");
  await page.click("#arm-all");
  msg = await confirmPlan(page, { HOT, owner: OWNER });
  check("re-arm: done", /armed/.test(msg), msg);
  await closePlan(page);
  const g2 = cast("call", TW, "chainConfig(uint256)((address,address,address,address[]))", "84532", "--rpc-url", RPC[5318007]).slice(1, 43);
  check("Base: a new Guardian is set and approved", !same(g2, G[84532]) && !/^0x0{40}$/.test(g2) && TOKENS.every((t) => allow(84532, t, HOT, g2) === MAXU));
  await waitText(page, "#main", "armed on all 2 chains");
  check("page: armed on all 2 chains again", true);
  await shot(page, "08-rearmed");
  relay.kill();
} catch (e) {
  console.error(e);
  failed++;
} finally {
  for (const p of relays) p.kill();
  await browser.close();
}

function same(a, b) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
const real = errors.filter((e) => !/favicon/.test(e));
check("no page errors", real.length === 0, real.slice(0, 5).join(" | "));
console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
