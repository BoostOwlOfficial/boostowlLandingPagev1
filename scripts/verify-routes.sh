#!/usr/bin/env bash
# ============================================================================
# Regression test for the Meta / WhatsApp scraper fix.
# See PROTECTED-ROUTES.md.
#
# Run after ANY change to vercel.json, .vercelignore, api/, or legal/.
#
#   ./scripts/verify-routes.sh                        # production
#   ./scripts/verify-routes.sh https://preview.url    # a preview deploy
# ============================================================================

set -uo pipefail

BASE="${1:-https://www.boostowl.io}"
PASS=0
FAIL=0

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }

ok()   { green "  PASS"; echo "  $1"; PASS=$((PASS+1)); }
bad()  { red   "  FAIL"; echo "  $1"; FAIL=$((FAIL+1)); }

# ----------------------------------------------------------------------------
# check_page <path> <must-contain>
# Asserts 200 (never 206), a complete document, and OG tags — both for a plain
# request and under the Range header that caused the original bug.
# ----------------------------------------------------------------------------
check_page() {
  # NB: separate `local` statements — under `set -u`, bash evaluates every RHS
  # on a single `local` line before assigning any of them.
  local path="$1"
  local needle="$2"
  local url="$BASE$path"
  echo
  echo "── $path"

  local code body
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$url")
  [[ "$code" == "200" ]] && ok "status 200" || bad "status $code (expected 200)"

  body=$(curl -sS "$url")
  grep -qi "</html>" <<<"$body" \
    && ok "complete document (</html> present)" \
    || bad "TRUNCATED — no closing </html>"

  grep -qi 'property="og:title"' <<<"$body" \
    && ok "og:title present" \
    || bad "og:title MISSING — Meta will not unfurl this"

  grep -qi 'property="og:image"' <<<"$body" \
    && ok "og:image present" \
    || bad "og:image MISSING"

  grep -qi "$needle" <<<"$body" \
    && ok "expected content found" \
    || bad "expected content missing: $needle"

  # THE regression test: Meta's crawler sends Range. A 206 here is the bug.
  local rcode rbody
  rcode=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Range: bytes=0-1023' "$url")
  if [[ "$rcode" == "206" ]]; then
    bad "Range request returned 206 — THIS IS THE ORIGINAL BUG. Meta will see a truncated page."
  else
    ok "Range request returned $rcode (not 206)"
  fi

  rbody=$(curl -sS -H 'Range: bytes=0-1023' "$url")
  grep -qi "</html>" <<<"$rbody" \
    && ok "full document served despite Range header" \
    || bad "Range header truncated the response — the fix has regressed"
}

# ----------------------------------------------------------------------------
# check_not_public <path>  — internal files must not be served
# ----------------------------------------------------------------------------
check_not_public() {
  local path="$1"
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE$path")
  if [[ "$code" == "404" || "$code" == "403" ]]; then
    ok "$path not public ($code)"
  else
    bad "$path IS PUBLIC ($code) — add it to .vercelignore"
  fi
}

echo "═══════════════════════════════════════════════════════════"
echo " Verifying $BASE"
echo "═══════════════════════════════════════════════════════════"

echo
echo "⛔ PROTECTED ROUTES (Meta verification depends on these)"
check_page "/terms.html"         "Terms"
check_page "/privacy.html"       "Privacy"
check_page "/data-deletion.html" "Deletion"

echo
echo "── blog route"
BLOG_CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/blog/welcome-to-the-boostowl-blog")
[[ "$BLOG_CODE" == "200" ]] && ok "/blog/:slug returns 200" || bad "/blog/:slug returned $BLOG_CODE"

echo
echo "🔒 INTERNAL FILES (must not be served)"
check_not_public "/CAREERS-ADMIN.md"
check_not_public "/PROTECTED-ROUTES.md"
check_not_public "/BLOG-README.md"
check_not_public "/db/01-schema.sql"
check_not_public "/db/03-seed-config.sql"
check_not_public "/scripts/verify-routes.sh"
check_not_public "/.env"

echo
echo "🔑 SOURCE MUST NOT LEAK"
for f in /api/terms.js /api/careers/apply.js; do
  if curl -sS "$BASE$f" | grep -q "process.env"; then
    bad "$f LEAKED SOURCE — env access visible in the response"
  else
    ok "$f does not leak source"
  fi
done

echo
echo "═══════════════════════════════════════════════════════════"
printf ' %s passed, ' "$(green "$PASS")"
if [[ $FAIL -gt 0 ]]; then
  printf '%s failed\n' "$(red "$FAIL")"
  echo "═══════════════════════════════════════════════════════════"
  echo " Read PROTECTED-ROUTES.md before deploying again."
  exit 1
fi
printf '%s failed\n' "0"
echo "═══════════════════════════════════════════════════════════"
