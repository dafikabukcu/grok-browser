#!/usr/bin/env bash
# Runs all tests against a local relay (wrangler dev), a mock Grok Bot webhook and a mock xAI API.
# Throwaway tokens are generated per run; nothing here touches a real relay, bot or xAI account.
# Needs Node 18+ and a Chrome for Testing / Chromium binary: set CHROME_PATH, or it is downloaded to test/.cache.
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
tok() { node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))'; }
export TEST_EXT=$(tok) TEST_REPLY=$(tok) TEST_KEY=$(tok)
# Local-only relay secrets for wrangler dev (git-ignored), pointing the relay at the mock webhook.
( umask 077; cat > "$ROOT/relay/.dev.vars" <<VARS
EXT_TOKEN=$TEST_EXT
REPLY_TOKEN=$TEST_REPLY
GROKBOT_WEBHOOK_URL=http://127.0.0.1:8799/hook
GROKBOT_WEBHOOK_KEY=$TEST_KEY
VARS
)
[ -d node_modules ] || npm ci --no-audit --no-fund
[ -d "$ROOT/relay/node_modules" ] || (cd "$ROOT/relay" && npm ci --no-audit --no-fund)
node gen-test-pdf.mjs >/dev/null
if [ -z "${CHROME_PATH:-}" ]; then
  CHROME_PATH=$(npx --yes @puppeteer/browsers install chrome@stable --path "$PWD/.cache" --format '{{path}}' 2>/dev/null | tail -1)
  export CHROME_PATH
fi
[ -x "${CHROME_PATH:-}" ] || { echo "No Chrome found (CHROME_PATH=${CHROME_PATH:-})"; exit 1; }
LOG=${TMPDIR:-/tmp}/grok-browser-tests; mkdir -p "$LOG"
cleanup() { pkill -f "mock-webhook.mjs" 2>/dev/null; pkill -f "mock-xai.mjs" 2>/dev/null; pkill -f "wrangler dev --port 8787" 2>/dev/null; pkill -f "http.server 8800" 2>/dev/null; true; }
cleanup; sleep 1; trap cleanup EXIT
start_relay() { rm -rf "$LOG/relay-state"; (cd "$ROOT/relay" && npx wrangler dev --port 8787 --persist-to "$LOG/relay-state" --var ASK_PER_MINUTE:20 >"$LOG/wrangler.log" 2>&1 &)
  for i in $(seq 90); do curl -s http://127.0.0.1:8787/health >/dev/null && return 0; sleep 1; done; echo "relay didn't start"; cat "$LOG/wrangler.log"; exit 1; }
MOCK_KEY=$TEST_KEY MOCK_REPLY=$TEST_REPLY node mock-webhook.mjs >"$LOG/mock.log" 2>&1 &
node mock-xai.mjs >"$LOG/mock-xai.log" 2>&1 &
(cd pages && python3 -m http.server 8800 --bind 127.0.0.1 >/dev/null 2>&1 &)
node unit-test.mjs; R0=$?
start_relay
node relay-test.mjs; R1=$?
pkill -f "wrangler dev --port 8787"; sleep 2; start_relay   # fresh rate-limit budget for the browser tests
node ext-test.mjs; R2=$?
pkill -f "wrangler dev --port 8787"; sleep 2; start_relay
node ext-test-activetab.mjs; R3=$?
echo "unit-test exit $R0, relay-test exit $R1, ext-test exit $R2, ext-test-activetab exit $R3"; exit $(( R0 || R1 || R2 || R3 ))
