#!/usr/bin/env node
// Records the Tripwire monitor page (demo/) as one 1920x1080 webm with a scene-timestamp JSON.
//   node tools/video/record.mjs [--live] [--out DIR] [--speed N] [--zoom Z] [--query "?..."] [--timeout SEC]
// Default is the simulated replay (?mock=1). --live opens the page against the public RPCs (demo/config.json or
// ?tripwire=0x...) and waits for a real trip: run the attack from a terminal while it records.
// Writes <out>/raw.webm and <out>/scenes.json ({id, start, end} in seconds from the start of raw.webm).
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const demoDir = resolve(here, "../../demo");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const live = flag("--live");
const outDir = resolve(opt("--out", join(here, "work")));
const zoom = Number(opt("--zoom", "1.25"));
const speed = opt("--speed", "1.5");
const timeoutS = Number(opt("--timeout", live ? "900" : "180"));
const query = opt("--query", live ? "?lookback=5" : `?mock=1&speed=${speed}`);

function loadPlaywright() {
  const cands = [process.env.PLAYWRIGHT_DIR, "playwright", "/home/a/apeir-online/browser/node_modules/playwright"].filter(Boolean);
  const req = createRequire(import.meta.url);
  for (const c of cands) { try { return req(c); } catch {} }
  throw new Error("Playwright not found; set PLAYWRIGHT_DIR to its node_modules/playwright path");
}
const { chromium } = loadPlaywright();
const exe = [process.env.CHROMIUM, ...readdirSafe("/home/a/.cache/ms-playwright").filter((d) => d.startsWith("chromium-")).map((d) => `/home/a/.cache/ms-playwright/${d}/chrome-linux/chrome`)].find((p) => p && existsSync(p));
function readdirSafe(d) { try { return readdirSync(d); } catch { return []; } }

// Static server for demo/ on localhost only.
const types = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };
const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const f = resolve(demoDir, "." + (p === "/" ? "/index.html" : p));
  if (!f.startsWith(demoDir) || !existsSync(f) || /\.local\.json$/.test(f) && false) { res.writeHead(404).end(); return; }
  res.writeHead(200, { "content-type": types[extname(f)] || "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(f));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

mkdirSync(outDir, { recursive: true });
const tmp = join(outDir, "rec-tmp");
rmSync(tmp, { recursive: true, force: true });
const browser = await chromium.launch({ executablePath: exe, args: ["--hide-scrollbars"] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, colorScheme: "dark", recordVideo: { dir: tmp, size: { width: 1920, height: 1080 } } });
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
page.on("request", (r) => { if (!live && !r.url().startsWith(base) && !r.url().startsWith("data:")) errs.push("external request: " + r.url()); });

const sleep = (s) => page.waitForTimeout(s * 1000);
// Smooth scroll so the video shows the movement; target = selector of a section, found by its <h2> text.
async function scrollTo(h2text) {
  await page.evaluate((t) => {
    const h = [...document.querySelectorAll("h2")].find((e) => e.textContent.trim().startsWith(t));
    const el = h ? h.closest("section") : null;
    const hdr = document.getElementById("header").offsetHeight * (parseFloat(document.documentElement.style.zoom) || 1);
    const y = el ? el.getBoundingClientRect().top + scrollY - hdr - 12 : 0;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }, h2text);
  await sleep(0.9);
}
const waitText = (re, sec) => page.waitForFunction((r) => new RegExp(r, "i").test(document.body.innerText), re, { timeout: sec * 1000 });
const waitSel = (sel, sec) => page.waitForSelector(sel, { timeout: sec * 1000 });

const scenes = [];
async function scene(id, fn) {
  const start = now();
  try { await fn(); } catch (e) { errs.push(`scene ${id}: ${e.message.split("\n")[0]}`); }
  scenes.push({ id, start: +start.toFixed(2), end: +now().toFixed(2) });
  console.log(`scene ${id} ${start.toFixed(1)}-${now().toFixed(1)}s`);
}

console.log(`recording ${live ? "LIVE" : "mock"} ${base}/index.html${query}`);
await page.goto(`${base}/index.html${query}`, { waitUntil: "load" });
await page.addStyleTag({ content: `html{zoom:${zoom}}` });
await page.evaluate((z) => (document.documentElement.style.zoom = String(z)), zoom);
await sleep(1);

// Scene ids match captions.json and STORYBOARD.md shots (page-only shots; terminal/README shots are not recorded here).
await scene("intro", async () => { await sleep(live ? 8 : 6); });
await scene("guarded", async () => { await scrollTo("What is guarded"); await sleep(8); });
await scene("normal", async () => {
  await scrollTo("Activity");
  await waitText("pre-cleared|intent stored", timeoutS);
  await sleep(7);
});
await scene("attack", async () => {
  await scrollTo("Trips");
  await waitSel(".trip", timeoutS);
  await scrollTo("Trips"); // the page grew: scroll again so the trip card is at the top
  await sleep(5);
});
await scene("sweeps", async () => {
  await waitSel(".trip.trip-swept", timeoutS);
  await scrollTo("Trips");
  await sleep(10);
});
await scene("pull", async () => {
  // The pull attempt moves nothing on the page; what shows it is the balances: hot wallet stays empty, vault holds it all.
  await scrollTo("Balances");
  await sleep(8);
});
await scene("proof", async () => { await scrollTo("Trips"); await sleep(9); });
await scene("latency", async () => { await scrollTo("Latency"); await sleep(12); });
await scene("outro", async () => { await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); await sleep(6); });

const finish = now();
await page.screenshot({ path: join(outDir, "last-frame.png") });
await ctx.close();
await browser.close();
server.close();
const vids = readdirSafe(tmp).filter((f) => f.endsWith(".webm"));
if (!vids.length) { console.error("no video produced"); process.exit(1); }
renameSync(join(tmp, vids[0]), join(outDir, "raw.webm"));
rmSync(tmp, { recursive: true, force: true });
writeFileSync(join(outDir, "scenes.json"), JSON.stringify({ mode: live ? "live" : "mock", pageLoadStart: 0, duration: +finish.toFixed(2), scenes }, null, 2) + "\n");
console.log(errs.length ? "PROBLEMS:\n" + errs.join("\n") : "no page errors");
console.log(`wrote ${join(outDir, "raw.webm")} (${finish.toFixed(1)} s)`);
if (errs.length && !live) process.exitCode = 2;
