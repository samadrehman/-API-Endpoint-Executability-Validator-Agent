#!/bin/bash

set -e

# --- colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "  ${GREEN}✓${NC} $1"; }
fail() { echo -e "  ${RED}✗${NC} $1"; }
warn() { echo -e "  ${YELLOW}!${NC} $1"; }

SETUP_OK=true

echo ""
echo "=== Endpoint Tester Setup ==="
echo ""

# --- check bun ---
if command -v bun >/dev/null 2>&1; then
	pass "Bun is installed ($(bun --version))"
else
	fail "Bun is not installed"
	echo "  Install: curl -fsSL https://bun.sh/install | bash"
	exit 1
fi
# --- install dependencies ---
echo ""
echo "Installing dependencies..."
bun install
pass "Dependencies installed"

# --- ensure .env exists ---
echo ""
if [ ! -f ".env" ]; then
	if [ -f ".env.example" ]; then
		cp .env.example .env
		pass "Created .env from .env.example"
	else
		cat > .env <<'EOF'
COMPOSIO_API_KEY=your_api_key_here
GMAIL_AUTH_CONFIG_ID=your_gmail_auth_config_id_here
GOOGLECALENDAR_AUTH_CONFIG_ID=your_google_calendar_auth_config_id_here
GMAIL_CONNECTED_ACCOUNT_ID=your_gmail_connected_account_id_here
GOOGLECALENDAR_CONNECTED_ACCOUNT_ID=your_googlecalendar_connected_account_id_here
EOF
		pass "Created .env template"
	fi
else
	pass ".env already exists"
fi

# --- validate required values in .env ---
echo ""
echo "Validating .env values..."

missing=()
for key in COMPOSIO_API_KEY GMAIL_AUTH_CONFIG_ID GOOGLECALENDAR_AUTH_CONFIG_ID GMAIL_CONNECTED_ACCOUNT_ID GOOGLECALENDAR_CONNECTED_ACCOUNT_ID; do
	value=$(grep -E "^${key}=" .env | head -n 1 | cut -d'=' -f2-)
	if [ -z "$value" ] || echo "$value" | grep -qiE "your_|xxxxx|changeme|<"; then
		missing+=("$key")
	fi
done

if [ ${#missing[@]} -eq 0 ]; then
	pass ".env looks complete"
else
	warn "Missing or placeholder values found in .env: ${missing[*]}"
	SETUP_OK=false
fi

# --- record start timestamp ---
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .start-timestamp
pass "Start timestamp recorded"

# --- summary ---
echo ""
echo "=== Setup Summary ==="
if [ "$SETUP_OK" = true ]; then
	echo -e "${GREEN}All checks passed. You're ready to run the project.${NC}"
else
	echo -e "${YELLOW}Setup completed with warnings — update .env before running tests.${NC}"
fi
echo ""
echo "Next steps:"
echo "  1. Edit .env and provide your real API key and account IDs"
echo "  2. Run: bun src/index.ts"
echo "  3. Run: bun src/run.ts"
echo ""
