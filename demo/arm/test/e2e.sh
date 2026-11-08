#!/usr/bin/env bash
# End-to-end check of the arm page (demo/arm/) on local chains only, with anvil's public dev accounts:
#   - three plain anvils: "Base Sepolia" 84532, "Unichain Sepolia" 1301, "Lasna" 5318007, with the mock system contract
#     and callback proxies etched where the real ones live (as tools/localnet/run.sh does);
#   - demo tokens and Intent/PanicButton from the repo's scripts; the rest is done by clicking through the page in
#     headless Chromium, with an injected EIP-1193 wallet that forwards to the anvils (test/e2e.mjs);
#   - tools/localnet/relay.mjs stands in for Reactive Network, so trips really sweep.
# Every flow is confirmed by reading chain state afterwards. Screenshots go to demo/arm/shots/.
#
#   demo/arm/test/e2e.sh          # PORT=28545 HTTP_PORT=8791 KEEP=1 (keep the work dir)
set -euo pipefail

R=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$R"
W=$(mktemp -d "${TMPDIR:-/tmp}/tripwire-arm-e2e.XXXXXX")
P=${PORT:-28545}
PB=$P PU=$((P + 1)) PL=$((P + 2))
HTTP=${HTTP_PORT:-8791}
B=http://127.0.0.1:$PB U=http://127.0.0.1:$PU L=http://127.0.0.1:$PL
SYS=0x8888888888888888888888888888888888888888
CFG=demo/arm/e2e.local.json

# Never reach a real network or a real key from here.
unset BASE_RPC ETH_RPC UNI_RPC LASNA_RPC TRIPWIRE PRIVATE_KEY HOT_PK COSIGNER_PK COLD_PK ATTACKER_PK ETH_RPC_URL SALT
export FOUNDRY_BROADCAST=$W/broadcast

PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -f "$R/$CFG"
  if [[ ${KEEP:-0} == 1 ]]; then echo "work dir kept: $W"; else rm -rf "$W"; fi
}
trap cleanup EXIT

echo "== anvils on $PB (Base Sepolia), $PU (Unichain Sepolia), $PL (Lasna)"
anvil --port "$PB" --chain-id 84532 --silent &
PIDS+=($!)
anvil --port "$PU" --chain-id 1301 --silent &
PIDS+=($!)
anvil --port "$PL" --chain-id 5318007 --silent &
PIDS+=($!)
for url in $B $U $L; do
  for _ in $(seq 1 120); do cast chain-id --rpc-url "$url" >/dev/null 2>&1 && break || sleep 0.25; done
  cast chain-id --rpc-url "$url" >/dev/null
done

echo "== etch the mock system contract and callback proxies"
forge build -q
cast rpc anvil_setCode $SYS "$(forge inspect MockSystem deployedBytecode)" --rpc-url "$L" >/dev/null
PROXY_CODE=$(forge inspect MockCallbackProxy deployedBytecode)
cast rpc anvil_setCode 0x476F44b11F5C942c58f4c8E3d0300E5710743585 "$PROXY_CODE" --rpc-url "$B" >/dev/null
cast rpc anvil_setCode 0x775c9B990ADe401060B78D0e98684eEf8d2466C1 "$PROXY_CODE" --rpc-url "$U" >/dev/null
node demo/arm/tools/build-contracts.mjs --check

# anvil's public dev mnemonic. Guard A (scripts, then the page): 0 owner, 1 HOT, 2 cosigner, 4 COLD.
# Guard B (all from the page): 5 HOT, 6 COLD, 7 cosigner and owner. 3 attacker, 8 payee.
MN="test test test test test test test test test test test junk"
export PRIVATE_KEY=$(cast wallet private-key "$MN" 0)
mapfile -t ACC < <(cast rpc eth_accounts --rpc-url "$B" | tr -d '[]"' | tr ',' '\n')
export HOT=${ACC[1]}

echo "== repo scripts: Intent + PanicButton on Base only (the page deploys Unichain's), demo tokens on both"
forge script script/DeploySignals.s.sol --rpc-url "$B" --broadcast >"$W/signals.log" 2>&1 || { tail -20 "$W/signals.log"; exit 1; }
INTENT=$(grep -oE 'INTENT=0x[0-9a-fA-F]{40}' "$W/signals.log" | cut -d= -f2)
PANIC=$(grep -oE 'PANIC=0x[0-9a-fA-F]{40}' "$W/signals.log" | cut -d= -f2)
TOKENS=$(forge script script/DeployMocks.s.sol --rpc-url "$B" --broadcast 2>&1 | grep -oE 'TOKENS=[0-9a-fA-Fx,]+' | cut -d= -f2)
TOKENS_U=$(forge script script/DeployMocks.s.sol --rpc-url "$U" --broadcast 2>&1 | grep -oE 'TOKENS=[0-9a-fA-Fx,]+' | cut -d= -f2)
[[ $TOKENS == "$TOKENS_U" && -n $TOKENS ]] || { echo "token addresses differ: $TOKENS vs $TOKENS_U"; exit 1; }
echo "INTENT=$INTENT PANIC=$PANIC TOKENS=$TOKENS"

# The page's config: the demo config's networks with local RPCs and no explorers, no tripwire yet.
node -e '
const [src, out, b, u, l] = process.argv.slice(1);
const cfg = JSON.parse(require("fs").readFileSync(src, "utf8"));
const urls = { 84532: b, 1301: u, 5318007: l };
const networks = {};
for (const [id, url] of Object.entries(urls)) networks[id] = { ...cfg.networks[id], rpc: url, explorer: "" };
require("fs").writeFileSync(out, JSON.stringify({ lasnaChainId: 5318007, tripwire: "", networks }, null, 2));
' demo/config.json "$CFG" "$B" "$U" "$L"

(cd demo && exec python3 -m http.server "$HTTP" --bind 127.0.0.1 >"$W/http.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$HTTP/arm/" && break || sleep 0.25; done

echo "== page"
E2E_BASE=$B E2E_UNI=$U E2E_LASNA=$L E2E_HTTP=http://127.0.0.1:$HTTP E2E_CONFIG=arm/e2e.local.json E2E_WORK=$W \
  E2E_TOKENS=$TOKENS E2E_INTENT=$INTENT E2E_PANIC=$PANIC E2E_ACCOUNTS=$(IFS=,; echo "${ACC[*]}") \
  node demo/arm/test/e2e.mjs
