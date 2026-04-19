#!/usr/bin/env bash
# smoke-gate.sh — verifica end-to-end che:
#   1. hook blocca (exit 1) quando .claude/cache/current-work-item.json manca
#   2. hook lascia passare (exit 0) con cache popolata e status=active
#   3. hook blocca (exit 1) con status=paused / done
#
# Non richiede Supabase — simula la cache manualmente.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$REPO_ROOT/.claude/hooks/governance-gate.sh"
CACHE="$REPO_ROOT/.claude/cache/current-work-item.json"

fail() { echo "[FAIL] $1"; exit 1; }
pass() { echo "[PASS] $1"; }

# Reset
rm -f "$CACHE"

# 1. No cache -> block
if bash "$HOOK" --agent board-mcp 2>/dev/null; then
  fail "gate doveva bloccare senza cache"
fi
pass "blocca correttamente senza cache"

# 2. Active WI -> pass
mkdir -p "$(dirname "$CACHE")"
cat > "$CACHE" <<'JSON'
{
  "id": "11111111-1111-1111-1111-111111111111",
  "agent_slug": "board-mcp",
  "intent": "smoke test",
  "status": "active",
  "pre_conditions": {},
  "in_flight_state": { "tool_uses": 0 }
}
JSON

if ! bash "$HOOK" --agent board-mcp 2>/dev/null; then
  fail "gate doveva passare con status=active"
fi
pass "passa con WI active"

# 3. Paused -> block
jq '.status = "paused"' "$CACHE" > "$CACHE.tmp" && mv "$CACHE.tmp" "$CACHE"
if bash "$HOOK" --agent board-mcp 2>/dev/null; then
  fail "gate doveva bloccare con status=paused"
fi
pass "blocca con WI paused"

# 4. Agent mismatch -> block
jq '.status = "active" | .agent_slug = "other-agent"' "$CACHE" > "$CACHE.tmp" && mv "$CACHE.tmp" "$CACHE"
if bash "$HOOK" --agent board-mcp 2>/dev/null; then
  fail "gate doveva bloccare su mismatch agent_slug"
fi
pass "blocca con agent mismatch"

# Cleanup
rm -f "$CACHE"
echo ""
echo "SMOKE GATE: OK"
