#!/usr/bin/env node
// Local stand-in for Reactive Network, for tools/localnet/run.sh. Only for anvil chains: it impersonates the system
// contract and needs unlocked accounts.
//
// It does what test/utils/OmniSim.sol does in-process, but across real JSON-RPC chains:
//   1. polls each origin chain for new logs;
//   2. asks the MockSystem etched at 0x8888…8888 on the "Lasna" anvil whether the Tripwire subscribed to the log
//      (MockSystem.matches) and, if so, calls react(LogRecord) as the system contract;
//   3. reads the callback requests that react() recorded (MockSystem.request) and delivers each through the
//      MockCallbackProxy etched at that chain's real callback-proxy address (it injects the sender and holds back gas
//      the way the live proxy does).
// The sweeps' own Transfer logs come back through step 1, as on the live network.
//
//   node tools/localnet/relay.mjs --lasna URL --chain 84532=URL --chain 1301=URL --tripwire 0x… [--poll 250]

import { parseArgs } from "node:util";

const SYSTEM = "0x8888888888888888888888888888888888888888";
const PROXY = {
  84532: "0x476F44b11F5C942c58f4c8E3d0300E5710743585",
  11155111: "0xAa14d9Cd0f788Ca23d11805986C1d8bd035D23b4",
  1301: "0x775c9B990ADe401060B78D0e98684eEf8d2466C1",
  8453: "0xCc780DdE33f56f55dE778D42c930959374a4a068", // mainnet (NET=mainnet tools/localnet/run.sh)
  1: "0xFCE1F192F489c988392aBC16E91e359d540d94Fe",
  130: "0x754120EC7a6eF81E4c5c835AA603C63Da64693E6",
};
const SEL = {
  matches: "0x1a5f0240", // matches(address,uint256,address,uint256[4])
  react: "0x0d152c2c", // react((uint256,address,uint256,uint256,uint256,uint256,bytes,uint256,uint256,uint256,uint256,uint256))
  requestCount: "0x5badbe4c", // requestCount()
  request: "0xd845a4b3", // request(uint256)
  deliver: "0x0f8baf7a", // deliver(address,address,uint64,bytes)
};

const { values } = parseArgs({
  options: {
    lasna: { type: "string" },
    chain: { type: "string", multiple: true },
    tripwire: { type: "string" },
    poll: { type: "string" },
  },
});
if (!values.lasna || !values.tripwire || !values.chain?.length) {
  console.error("usage: relay.mjs --lasna URL --chain ID=URL [--chain ID=URL] --tripwire 0x… [--poll ms]");
  process.exit(1);
}
const chains = Object.fromEntries(values.chain.map((s) => s.split("=")).map(([id, url]) => [Number(id), url]));
const tripwire = values.tripwire.toLowerCase();
const pollMs = Number(values.poll || 250);

const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);
const pad = (v) => (typeof v === "string" && v.startsWith("0x") ? strip(v).toLowerCase().padStart(64, "0") : BigInt(v).toString(16).padStart(64, "0"));
const bytes = (hex) => {
  const h = strip(hex || "0x");
  return pad(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, "0");
};
const num = (hex) => Number(BigInt(hex));
const ts = () => new Date().toISOString().slice(11, 23);

let id = 0;
async function rpc(url, method, params = []) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

async function send(url, tx) {
  const hash = await rpc(url, "eth_sendTransaction", [tx]);
  for (let i = 0; i < 200; i++) {
    const rc = await rpc(url, "eth_getTransactionReceipt", [hash]);
    if (rc) return rc;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no receipt for ${hash}`);
}

async function subscribed(chainId, log) {
  const topics = [0, 1, 2, 3].map((k) => log.topics[k] || "0x0");
  const data = SEL.matches + pad(tripwire) + pad(chainId) + pad(log.address) + topics.map(pad).join("");
  return BigInt(await rpc(values.lasna, "eth_call", [{ to: SYSTEM, data }, "latest"])) === 1n;
}

function reactCalldata(chainId, log) {
  const t = [0, 1, 2, 3].map((k) => log.topics[k] || "0x0");
  const head = [chainId, log.address, ...t, 12 * 32, num(log.blockNumber), log.topics.length, log.blockHash, log.transactionHash, num(log.logIndex)];
  return SEL.react + pad(0x20) + head.map(pad).join("") + bytes(log.data);
}

let relayer = {};
let delivered = 0;

async function relayCallbacks() {
  const total = num(await rpc(values.lasna, "eth_call", [{ to: SYSTEM, data: SEL.requestCount }, "latest"]));
  for (; delivered < total; delivered++) {
    const ret = strip(await rpc(values.lasna, "eth_call", [{ to: SYSTEM, data: SEL.request + pad(delivered) }, "latest"]));
    const w = (i) => ret.slice(64 * i, 64 * (i + 1));
    const base = num("0x" + w(0)) / 32; // tuple offset in words
    const chainId = num("0x" + w(base));
    const sender = "0x" + w(base + 1).slice(24);
    const recipient = "0x" + w(base + 2).slice(24);
    const gasLimit = num("0x" + w(base + 3));
    const pOff = base + num("0x" + w(base + 4)) / 32;
    const len = num("0x" + w(pOff));
    const payload = "0x" + ret.slice(64 * (pOff + 1), 64 * (pOff + 1) + len * 2);
    const url = chains[chainId];
    if (!url || !PROXY[chainId]) {
      console.log(`${ts()} callback #${delivered} to chain ${chainId}: no such local chain, dropped`);
      continue;
    }
    const data = SEL.deliver + pad(recipient) + pad(sender) + pad(gasLimit) + pad(0x80) + bytes(payload);
    const rc = await send(url, { from: relayer[chainId], to: PROXY[chainId], data, gas: "0x" + (gasLimit + 200_000).toString(16) });
    console.log(`${ts()} callback #${delivered} → ${chainId} ${recipient} gas ${gasLimit}: ${rc.status === "0x1" ? "delivered" : "REVERTED"} ${rc.transactionHash}`);
  }
}

async function main() {
  await rpc(values.lasna, "anvil_impersonateAccount", [SYSTEM]);
  await rpc(values.lasna, "anvil_setBalance", [SYSTEM, "0x3635c9adc5dea00000"]);
  const cursor = {};
  for (const [cid, url] of Object.entries(chains)) {
    cursor[cid] = num(await rpc(url, "eth_blockNumber")) + 1;
    relayer[cid] = (await rpc(url, "eth_accounts"))[9];
  }
  delivered = num(await rpc(values.lasna, "eth_call", [{ to: SYSTEM, data: SEL.requestCount }, "latest"]));
  console.log(`${ts()} relay up: Tripwire ${tripwire}, chains ${Object.keys(chains).join(", ")}, ${delivered} earlier callback requests skipped`);

  for (;;) {
    try {
      for (const [cid, url] of Object.entries(chains)) {
        const latest = num(await rpc(url, "eth_blockNumber"));
        if (latest < cursor[cid]) continue;
        const logs = await rpc(url, "eth_getLogs", [{ fromBlock: "0x" + cursor[cid].toString(16), toBlock: "0x" + latest.toString(16) }]);
        logs.sort((a, b) => num(a.blockNumber) - num(b.blockNumber) || num(a.logIndex) - num(b.logIndex));
        for (const l of logs) {
          if (!(await subscribed(Number(cid), l))) continue;
          const rc = await send(values.lasna, { from: SYSTEM, to: tripwire, data: reactCalldata(Number(cid), l), gas: "0x2dc6c0" });
          console.log(`${ts()} react ${cid} ${l.transactionHash}#${num(l.logIndex)}: ${rc.status === "0x1" ? "ok" : "REVERTED"} gas ${num(rc.gasUsed)}`);
          await relayCallbacks();
        }
        cursor[cid] = latest + 1;
      }
    } catch (e) {
      console.log(`${ts()} relay error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

main();
