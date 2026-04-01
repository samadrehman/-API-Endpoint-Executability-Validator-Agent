# Troubleshooting Guide

## Common Issues & Solutions

### 1. Configuration Issues

#### "Missing required env variables"
**Problem**: Missing COMPOSIO_API_KEY, GMAIL_AUTH_CONFIG_ID, or GOOGLECALENDAR_AUTH_CONFIG_ID

**Solution**:
```bash
# Step 1: Set up .env file
cp .env.example .env

# Step 2: Get API key and run scaffold
COMPOSIO_API_KEY=<your-key> sh scaffold.sh

# Step 3: This will output:
# GMAIL_AUTH_CONFIG_ID=...
# GOOGLECALENDAR_AUTH_CONFIG_ID=...
# Copy these values to .env

# Step 4: Load the environment
source .env  # On Unix/Linux/Mac
# Or set variables manually on Windows
```

#### Environment variables not loading
**Problem**: .env file exists but variables aren't being read

**Solution on Windows/PowerShell**:
```powershell
# Method 1: Load before running
$env:COMPOSIO_API_KEY = "your-key"
$env:GMAIL_AUTH_CONFIG_ID = "config-id"
$env:GOOGLECALENDAR_AUTH_CONFIG_ID = "config-id"
$env:GMAIL_CONNECTED_ACCOUNT_ID = "ca-id"
$env:GOOGLECALENDAR_CONNECTED_ACCOUNT_ID = "ca-id"
bun src/run.ts

# Method 2: Create .env locally in current directory
# Bun will automatically load it
```

**Solution on Unix/Linux/Mac**:
```bash
source .env
bun src/run.ts
```

---

### 2. Authentication Issues

#### "Auth config IDs not set"
**Problem**: Can't connect Gmail and Calendar accounts

**Solution**:
```bash
# Make sure you have COMPOSIO_API_KEY set
export COMPOSIO_API_KEY=<your-key>

# Run scaffold
COMPOSIO_API_KEY=$COMPOSIO_API_KEY sh scaffold.sh

# Wait for auth config IDs to appear
# Then connect accounts
bun src/connect.ts

# Follow the prompts to authenticate in your browser
# Confirm connection for each account
```

#### "Connected account IDs not set"
**Problem**: Already created auth configs, but haven't linked accounts

**Solution**:
```bash
# These are different from auth config IDs
# To create connected accounts:
bun src/connect.ts

# This will:
# 1. Load GMAIL_AUTH_CONFIG_ID from env
# 2. Open browser to Google OAuth
# 3. You authorize the app
# 4. Output connected account IDs
# 5. Add these to your .env

# Copy the output account IDs to .env:
# GMAIL_CONNECTED_ACCOUNT_ID=ca_xxxxx
# GOOGLECALENDAR_CONNECTED_ACCOUNT_ID=ca_xxxxx
```

#### "401 Unauthorized" or "insufficient_scopes"
**Problem**: Auth credentials exist but permission is denied

**Solution**:
```bash
# 1. Check that connected account ID is correct
echo $GMAIL_CONNECTED_ACCOUNT_ID

# 2. If scope issue, regenerate with scaffold
sh scaffold.sh

# 3. Reconnect accounts with proper scopes
bun src/connect.ts

# 4. Run with debug to see what's happening
DEBUG=* bun src/run.ts
```

---

### 3. Endpoint Testing Issues

#### "Skipping {messageId} — no cached value"
**Problem**: Endpoint depends on a path parameter that wasn't found

**Solution**:
This is expected behavior. The agent:
1. Lists messages first to get a messageId
2. Then tests endpoints that need that messageId

If all list endpoints fail, dependent endpoints will be skipped. Check:
```bash
DEBUG=* bun src/run.ts
# Look for log entries showing which endpoints succeeded
```

#### Status: "invalid_endpoint" but endpoint should exist
**Problem**: Endpoint classified as 404 when it possibly exists

**Solutions**:
1. **Wrong path format**:
   - Check `endpoints.json` for correct path
   - Verify method (GET vs POST, etc.)

2. **Outdated API version**:
   - Gmail API moved from v1 → might have breaking changes
   - Check official API docs for current endpoints

3. **Account doesn't have data**:
   - Endpoint exists but returns empty: classified as valid
   - Endpoint exists but no permission: classified as insufficient_scopes

4. **Debug the request**:
   ```bash
   DEBUG=* bun src/run.ts 2>&1 | grep -i "tool_slug"
   # Shows detailed request/response info
   ```

#### "error" status but not clear what happened
**Problem**: Unclear error classification

**Solution**:
```bash
# Run with debug logging to see full error details
DEBUG=* bun src/run.ts

# Look for lines with error messages
# They'll show:
# - HTTP status code
# - Error message
# - Response body (if available)
```

---

### 4. Installation Issues

#### "Bun command not found"
**Problem**: Bun runtime isn't installed

**Solution**:
```bash
# Install Bun (replaces Node in this project)
curl -fsSL https://bun.sh/install | bash

# Or using Homebrew (Mac)
brew install oven-sh/bun/bun

# Verify
bun --version
```

#### "Cannot find module @composio/core"
**Problem**: Dependencies not installed

**Solution**:
```bash
# Install dependencies
bun install

# Or with npm
npm install

# Clear cache if stuck
rm -rf node_modules bun.lock
bun install
```

---

### 5. Output & Reporting Issues

#### "report.json is empty or incomplete"
**Problem**: Test run completed but results are missing

**Solutions**:
1. **Check if it ran at all**:
   ```bash
   cat report.json | jq '.total_endpoints'
   # Shows number of endpoints tested
   ```

2. **View summary**:
   ```bash
   cat report.json | jq '.summary'
   # Shows counts: valid, invalid_endpoint, insufficient_scopes, error
   ```

3. **See specific failures**:
   ```bash
   cat report.json | jq '.results[] | select(.status == "error")'
   # Shows only failed endpoints
   ```

---

### 6. Performance Issues

#### "Test is taking very long"
**Problem**: Too many slow API requests

**Solutions**:
```bash
# Check how many endpoints you're testing
bun src/index.ts
# Shows endpoint count

# Parallel execution (built-in)
# The agent tests multiple endpoints concurrently
# Check logs to see parallelism:
DEBUG=* bun src/run.ts 2>&1 | head -50
```

---

### 7. Debugging Tips

#### See what the agent is doing
```bash
# Enable debug logging
DEBUG=* bun src/run.ts

# For more verbose logging
LOG_LEVEL=debug DEBUG=* bun src/run.ts
```

#### Inspect specific request/response
```bash
# Run and filter for a specific endpoint
DEBUG=* bun src/run.ts 2>&1 | grep "GMAIL_LIST_MESSAGES"

# View full response for debugging
cat report.json | jq '.results[0]'
```

#### Test a single endpoint manually
```typescript
// In a test file:
import { Composio } from "@composio/core";

const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY!,
});

const result = await composio.tools.proxyExecute({
  endpoint: "/gmail/v1/users/me/messages",
  method: "GET",
  connectedAccountId: process.env.GMAIL_CONNECTED_ACCOUNT_ID!,
  parameters: [
    { in: "query", name: "maxResults", value: 5 }
  ],
});

console.log(result);
```

---

### 8. Still Stuck?

1. **Check the logs**:
   ```bash
   DEBUG=* bun src/run.ts 2>&1 | tee debug.log
   # Saves to file for inspection
   ```

2. **Review the report**:
   ```bash
   cat report.json | jq '.' | head -100
   ```

3. **Check GitHub Issues**:
   - Search for your error
   - Create a new issue with:
     - Error message (from logs)
     - Steps to reproduce
     - Your environment (OS, Node/Bun version)

4. **Contact **:
   - Email: samadrehman550@gmail.com
   - Include debug logs from `DEBUG=* bun src/run.ts`
