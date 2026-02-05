#!/usr/bin/env bash
# sign-repo.sh — regenerate and Archon-sign manifest.json for this repo.
# Run this before EVERY push.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHON_DIR="${ARCHON_CONFIG_DIR:-$HOME/.config/hex/archon}"

cd "$REPO_DIR"

if [[ ! -f "$ARCHON_DIR/wallet.json" ]]; then
  echo "Error: No Archon wallet at $ARCHON_DIR/wallet.json" >&2
  exit 1
fi

export ARCHON_GATEKEEPER_URL="${ARCHON_GATEKEEPER_URL:-https://archon.technology}"
if [[ -z "${ARCHON_PASSPHRASE:-}" ]]; then
  echo "Error: ARCHON_PASSPHRASE not set" >&2
  exit 1
fi

# Prefer explicit DID, fallback to Hex's current DID.
SIGN_DID="${ARCHON_SIGN_DID:-did:cid:bagaaieratn3qejd6mr4y2bk3nliriafoyeftt74tkl7il6bbvakfdupahkla}"

# Normalize repo URL to https://github.com/OWNER/REPO
origin=$(git remote get-url origin 2>/dev/null || true)
if [[ "$origin" =~ ^git@github.com:(.*)\.git$ ]]; then
  repo_url="https://github.com/${BASH_REMATCH[1]}"
elif [[ "$origin" =~ ^https://github.com/.*$ ]]; then
  repo_url="${origin%.git}"
else
  repo_url="(unknown)"
fi

TMP_MANIFEST="$ARCHON_DIR/manifest.json"

echo "=== Generating manifest for $repo_url ==="
{
  echo '{'
  echo '  "@context": "https://w3id.org/security/v2",'
  echo '  "type": "RepoManifest",'
  echo "  \"issuer\": \"$SIGN_DID\","
  echo "  \"created\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"repository\": \"$repo_url\","
  echo '  "files": ['

  # Exclude: .git, existing manifest.json, node_modules, venvs, and DBs.
  find . -type f \
    ! -path './.git/*' \
    ! -name 'manifest.json' \
    ! -path './node_modules/*' \
    ! -path './.venv/*' \
    ! -name '*.db' \
    ! -name '*.sqlite3' \
    | sort \
    | while read -r f; do
        hash=$(sha256sum "$f" | cut -d' ' -f1)
        # Keep paths relative and ./ prefixed like the original.
        echo "    {\"path\": \"$f\", \"sha256\": \"$hash\"},"
      done \
    | sed '$ s/,$//'

  echo '  ]'
  echo '}'
} > "$TMP_MANIFEST"

echo "=== Signing manifest (Archon) ==="
( cd "$ARCHON_DIR" && npx @didcid/keymaster sign-file manifest.json ) > "$REPO_DIR/manifest.json" 2>&1

echo "=== Verifying signature ==="
( cd "$ARCHON_DIR" && npx @didcid/keymaster verify-file "$REPO_DIR/manifest.json" ) >/dev/null 2>&1 \
  || { echo "Error: manifest signature verify failed" >&2; exit 1; }

echo "=== Done ==="
echo "manifest.json updated + signed. Commit it before pushing."
