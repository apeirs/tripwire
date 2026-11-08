#!/usr/bin/env bash
# Full local loop for tools/measure.mjs, with no testnet transaction and no real key:
#   - anvil "Base Sepolia" (chain 84532), a fork of the public Base Sepolia RPC, so Circle's real USDC bytecode is
#     there (LOCAL_FORK=0: plain anvil, demo tokens only);
#   - anvil "Unichain Sepolia" (chain 1301), plain;
#   - anvil "Lasna" (chain 5318007) with test/mocks/MockSystem.sol etched at 0x8888…8888, and
#     test/mocks/MockCallbackProxy.sol etched at both chains' real callback-proxy addresses;
#   - tools/localnet/relay.mjs as Reactive Network (subscription match → react() → callback delivery).
# The README's deploy steps run unchanged (forge scripts, CREATE2, Configure with USDC=true on Base, Arm), then
# measure.mjs runs against it and its outputs and the cooldown restore are checked, including on timeout and Ctrl-C.
# Keys are anvil's public dev accounts. Everything is written to a temp dir; README.md and docs/ are not touched.
#
#   tools/localnet/run.sh            # RUNS=3 PORT=18545 KEEP=1 (keep the temp dir) LOCAL_FORK=0
#   HOLD=1 tools/localnet/run.sh     # then keep it running and serve the demo page on it (DEMO_PORT=8767)
set -euo pipefail

R=$(cd "$(dirname "$0")/../.." && pwd)
cd "$R"
W=$(mktemp -d "${TMPDIR:-/tmp}/tripwire-localnet.XXXXXX")
RUNS=${RUNS:-3}
P=${PORT:-18545}
PB=$P PU=$((P + 1)) PL=$((P + 2))
BASE_FORK_RPC=${BASE_FORK_RPC:-https://sepolia.base.org}
LOCAL_FORK=${LOCAL_FORK:-1}
B=http://127.0.0.1:$PB U=http://127.0.0.1:$PU L=http://127.0.0.1:$PL
USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
SYS=0x8888888888888888888888888888888888888888

# Never reach a real network or a real key from here.
unset BASE_RPC ETH_RPC UNI_RPC LASNA_RPC TRIPWIRE PRIVATE_KEY HOT_PK COSIGNER_PK COLD_PK ATTACKER_PK ETH_RPC_URL
export FOUNDRY_BROADCAST=$W/broadcast

PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  if [[ ${KEEP:-0} == 1 || ${FAILED:-0} == 1 ]]; then echo "work dir kept: $W"; else rm -rf "$W"; fi
}
trap cleanup EXIT

say() { printf '\n== %s\n' "$*"; }
FAILED=0
check() { # check <description> <command...>
  local d=$1
  shift
  if "$@"; then echo "PASS $d"; else echo "FAIL $d"; FAILED=1; fi
}

say "anvils on $PB (Base Sepolia$([[ $LOCAL_FORK == 1 ]] && echo ", fork")), $PU (Unichain Sepolia), $PL (Lasna)"
if [[ $LOCAL_FORK == 1 ]]; then
  anvil --port "$PB" --chain-id 84532 --fork-url "$BASE_FORK_RPC" --silent &
else
  anvil --port "$PB" --chain-id 84532 --silent &
fi
PIDS+=($!)
anvil --port "$PU" --chain-id 1301 --silent &
PIDS+=($!)
anvil --port "$PL" --chain-id 5318007 --silent &
PIDS+=($!)
for url in $B $U $L; do
  for _ in $(seq 1 120); do cast chain-id --rpc-url "$url" >/dev/null 2>&1 && break || sleep 0.5; done
  cast chain-id --rpc-url "$url" >/dev/null
done

say "etch the mock system contract and callback proxies"
forge build -q
SYS_CODE=$(forge inspect MockSystem deployedBytecode)
PROXY_CODE=$(forge inspect MockCallbackProxy deployedBytecode)
cast rpc anvil_setCode $SYS "$SYS_CODE" --rpc-url "$L" >/dev/null
cast rpc anvil_setCode 0x476F44b11F5C942c58f4c8E3d0300E5710743585 "$PROXY_CODE" --rpc-url "$B" >/dev/null
cast rpc anvil_setCode 0x775c9B990ADe401060B78D0e98684eEf8d2466C1 "$PROXY_CODE" --rpc-url "$U" >/dev/null

# anvil's public dev mnemonic: 0 deployer/owner, 1 HOT, 2 cosigner, 3 attacker, 4 COLD
MN="test test test test test test test test test test test junk"
key() { cast wallet private-key "$MN" "$1"; }
mapfile -t ACC < <(cast rpc eth_accounts --rpc-url "$U" | tr -d '[]"' | tr ',' '\n')
export PRIVATE_KEY=$(key 0) HOT_PK=$(key 1) COSIGNER_PK=$(key 2) ATTACKER_PK=$(key 3) COLD_PK=$(key 4)
export DEPLOYER=${ACC[0]} HOT=${ACC[1]} COSIGNER=${ACC[2]} ATTACKER=${ACC[3]} COLD=${ACC[4]}
# A fresh CREATE2 salt, so the fork never collides with contracts deployed on the real Base Sepolia.
export SALT=$(cast keccak "tripwire-localnet-$(date +%s%N)")

fs() { # fs <script> <rpc> [VAR=value...]: run a forge script with extra env, log to the work dir
  local s=$1 url=$2 f
  shift 2
  f=$W/$(basename "$s").$(date +%s%N).log
  env "$@" forge script "$s" --rpc-url "$url" --broadcast >"$f" 2>&1 || {
    echo "forge script $s failed:" >&2
    tail -20 "$f" >&2
    return 1
  }
  cat "$f"
}
grab() { grep -oE "$1=0x[0-9a-fA-F]{40}(,0x[0-9a-fA-F]{40})*" | tail -1 | cut -d= -f2; }

say "deploy (README steps 1-5)"
OUT=$(fs script/DeploySignals.s.sol "$B")
INTENT=$(grab INTENT <<<"$OUT") PANIC=$(grab PANIC <<<"$OUT")
fs script/DeploySignals.s.sol "$U" >/dev/null
TOKENS=$(fs script/DeployMocks.s.sol "$B" | grab TOKENS)
fs script/DeployMocks.s.sol "$U" >/dev/null
TRIPWIRE=$(fs script/DeployReactive.s.sol "$L" CHAIN_IDS=84532,1301 INTENTS=$INTENT,$INTENT PANICS=$PANIC,$PANIC FUND=2ether | grab TRIPWIRE)
G_BASE=$(fs script/DeployGuardian.s.sol "$B" TRIPWIRE=$TRIPWIRE FUND=0.01ether | grab GUARDIAN)
G_UNI=$(fs script/DeployGuardian.s.sol "$U" TRIPWIRE=$TRIPWIRE FUND=0.01ether | grab GUARDIAN)
if [[ $LOCAL_FORK == 1 ]]; then BASE_REAL=(USDC=true USDC_THRESHOLD=1000000); else BASE_REAL=(); fi
fs script/Configure.s.sol "$L" TRIPWIRE=$TRIPWIRE CHAIN_ID=84532 GUARDIAN=$G_BASE TOKENS=$TOKENS "${BASE_REAL[@]}" | grep configured
fs script/Configure.s.sol "$L" TRIPWIRE=$TRIPWIRE CHAIN_ID=1301 GUARDIAN=$G_UNI TOKENS=$TOKENS | grep configured
fs script/Arm.s.sol "$B" GUARDIAN=$G_BASE TOKENS=$TOKENS "${BASE_REAL[@]}" | grep -E 'decimals|armed'
fs script/Arm.s.sol "$U" GUARDIAN=$G_UNI TOKENS=$TOKENS | grep armed
echo "TRIPWIRE=$TRIPWIRE G_BASE=$G_BASE G_UNI=$G_UNI TOKENS=$TOKENS"

if [[ $LOCAL_FORK == 1 ]]; then
  say "20 real (forked) USDC to HOT, minted the way Circle mints: master minter → minter → mint"
  MM=$(cast call $USDC "masterMinter()(address)" --rpc-url "$B")
  cast rpc anvil_impersonateAccount "$MM" --rpc-url "$B" >/dev/null
  cast rpc anvil_setBalance "$MM" 0x56bc75e2d63100000 --rpc-url "$B" >/dev/null
  cast send $USDC "configureMinter(address,uint256)" "$DEPLOYER" 1000000000000 --from "$MM" --unlocked --rpc-url "$B" >/dev/null
  cast send $USDC "mint(address,uint256)" "$HOT" 20000000 --private-key "$PRIVATE_KEY" --rpc-url "$B" >/dev/null
  # The dev accounts may already hold Base Sepolia USDC in the forked state: count it in.
  COLD_USDC0=$(cast call $USDC "balanceOf(address)(uint256)" "$COLD" --rpc-url "$B" | cut -d' ' -f1)
  HOT_USDC0=$(cast call $USDC "balanceOf(address)(uint256)" "$HOT" --rpc-url "$B" | cut -d' ' -f1)
  echo "USDC: HOT $HOT_USDC0, COLD $COLD_USDC0 (raw, 6 decimals)"
fi

say "relay (mock Reactive Network)"
node tools/localnet/relay.mjs --lasna "$L" --chain 84532="$B" --chain 1301="$U" --tripwire "$TRIPWIRE" >"$W/relay.log" 2>&1 &
RELAY=$!
PIDS+=($RELAY)
sleep 1

node -e '
const [src, out, b, u, l] = process.argv.slice(1);
const cfg = JSON.parse(require("fs").readFileSync(src, "utf8"));
const urls = { 84532: b, 1301: u, 5318007: l };
const networks = {};
for (const [id, url] of Object.entries(urls)) networks[id] = { ...cfg.networks[id], rpc: url, explorer: "" }; // keep maxRange: the Base fork forwards pre-fork ranges to the public RPC (200-block cap)
require("fs").writeFileSync(out, JSON.stringify({ lasnaChainId: 5318007, tripwire: "", networks }, null, 2));
' demo/config.json "$W/config.json" "$B" "$U" "$L"
cp README.md "$W/README.md"
cooldown() { cast call "$TRIPWIRE" "tripCooldown()(uint64)" --rpc-url "$L"; }
M=(node tools/measure.mjs --config "$W/config.json" --tripwire "$TRIPWIRE" --csv "$W/latency.csv" --readme "$W/README.md" --source localnet --gap 1)

say "dry run"
"${M[@]}" --dry-run --runs "$RUNS" --origin all --refill

say "measure: $RUNS runs, origin rotating Base → Unichain, demo token transfer"
set +e
"${M[@]}" --runs "$RUNS" --origin all --refill --timeout 120
RC=$?
set -e
check "measure exit 0" test $RC -eq 0
check "tripCooldown restored to 300" test "$(cooldown)" = 300
OKROWS=$(grep -c ',ok,' "$W/latency.csv" || true)
check "CSV has $((RUNS * 2)) ok rows (runs × 2 destination chains), got $OKROWS" test "$OKROWS" -eq $((RUNS * 2))
check "README copy got the table" grep -q '| Base Sepolia | \*\*origin block → last sweep block' "$W/README.md"

if [[ $LOCAL_FORK == 1 ]]; then
  say "measure: the trip is a real-USDC transfer itself (2 USDC, threshold 1 USDC)"
  set +e
  "${M[@]}" --runs 1 --origin base --token USDC --amount 2 --refill --timeout 120
  RC=$?
  set -e
  check "USDC run exit 0" test $RC -eq 0
  COLD_USDC=$(cast call $USDC "balanceOf(address)(uint256)" "$COLD" --rpc-url "$B" | cut -d' ' -f1)
  HOT_USDC=$(cast call $USDC "balanceOf(address)(uint256)" "$HOT" --rpc-url "$B" | cut -d' ' -f1)
  echo "USDC after: HOT $HOT_USDC, COLD $COLD_USDC"
  check "all USDC but the 2 sent is in COLD, HOT empty" test "$HOT_USDC" = 0 -a "$COLD_USDC" = $((COLD_USDC0 + HOT_USDC0 - 2000000))
  # last Base row of the CSV (USDC run): 3 demo tokens + USDC swept (columns 17 dest_chain, 22 swept)
  check "USDC run swept 4 tokens on Base (3 demo + USDC)" awk -F, '$17 == 84532 { s = $22 } END { exit s != 4 }' "$W/latency.csv"
fi

say "failure paths: relay stopped, so nothing reacts"
kill "$RELAY"
set +e
"${M[@]}" --runs 1 --timeout 6 --csv "$W/timeout.csv" --no-readme
RC=$?
set -e
check "timeout run exits 2" test $RC -eq 2
check "timeout row recorded" grep -q ',timeout,' "$W/timeout.csv"
check "tripCooldown restored after the timeout" test "$(cooldown)" = 300

"${M[@]}" --runs 1 --timeout 300 --csv "$W/sigint.csv" --no-readme >"$W/sigint.log" 2>&1 &
MP=$!
for _ in $(seq 1 240); do grep -q '  origin' "$W/sigint.log" && break || sleep 0.5; done
check "cooldown is 0 mid-run" test "$(cooldown)" = 0
kill -INT $MP
set +e
wait $MP
RC=$?
set -e
tail -3 "$W/sigint.log"
check "Ctrl-C exits 130" test $RC -eq 130
check "tripCooldown restored after Ctrl-C" test "$(cooldown)" = 300

say "relay log (last lines)"
tail -8 "$W/relay.log"
say "latency table written to the README copy"
sed -n '/measure:latency:begin/,/measure:latency:end/p' "$W/README.md"
[[ -n ${OUT_CSV:-} ]] && cp "$W/latency.csv" "$OUT_CSV"
[[ $FAILED == 0 ]] && say "ALL CHECKS PASSED" || { say "SOME CHECKS FAILED"; exit 1; }

if [[ ${HOLD:-0} == 1 ]]; then
  # Keep the chains up and show them on the demo page (live mode, local RPCs). Ctrl-C to stop.
  node tools/localnet/relay.mjs --lasna "$L" --chain 84532="$B" --chain 1301="$U" --tripwire "$TRIPWIRE" >>"$W/relay.log" 2>&1 &
  PIDS+=($!)
  node -e 'const f=process.argv[1],c=JSON.parse(require("fs").readFileSync(f,"utf8"));c.tripwire=process.argv[2];c.lookbackMinutes=30;c.labels={[process.argv[3]]:"attacker"};require("fs").writeFileSync(process.argv[4],JSON.stringify(c,null,2))' \
    "$W/config.json" "$TRIPWIRE" "$ATTACKER" demo/localnet.local.json
  (cd demo && exec python3 -m http.server "${DEMO_PORT:-8767}" --bind 127.0.0.1 >/dev/null 2>&1) &
  PIDS+=($!)
  say "holding: http://127.0.0.1:${DEMO_PORT:-8767}/?config=localnet.local.json  (more trips: ${M[*]} --runs 1 --no-readme)"
  echo "TRIPWIRE=$TRIPWIRE CONFIG=$W/config.json"
  trap 'rm -f demo/localnet.local.json; cleanup' EXIT
  while sleep 3600; do :; done
fi
