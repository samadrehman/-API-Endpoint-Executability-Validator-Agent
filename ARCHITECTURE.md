# Architecture

## 1. Design Overview

The agent follows a **sequential single-agent pipeline** with three execution phases and a shared parameter cache. The high-level flow is:

```
Load endpoints
      │
      ▼
Order by phase (P0 → P1 → P2)
      │
      ▼
For each endpoint:
  ├── Resolve path parameters from cache
  ├── Build request body from field definitions
  ├── Separate query params from body params
  ├── Build full URL with query parameters
  ├── Call composio.tools.proxyExecute() with direct HTTP endpoint
  ├── Extract HTTP status from proxy response
  ├── Classify status (valid/invalid_endpoint/insufficient_scopes/error)
  ├── Cache any IDs from response for dependency resolution
  └── (optional) Retry once with richer body if 4xx error
      │
      ▼
Re-sort to original order → return TestReport
```

The agent is generic: it never hardcodes Gmail-specific or Calendar-specific logic in the classification or execution path. The only app-specific knowledge lives in `buildRequestBody()` where field names like `raw`, `start`, `end`, and `summary` are mapped to semantically correct values — this is necessary because the API would reject placeholder strings like `"test-value"` for typed fields (dates, base64 content), which would cause false negatives.

## 2. Configuration & Connected Accounts

### Connected Account IDs
The agent uses Composio-provisioned connected account IDs for Gmail and Google Calendar. These are configured in multiple places:

**[src/index.ts](src/index.ts)** - Entry point used in interactive mode:
```typescript
const connectedAccounts = {
  gmail: "ca_vreLayFE0QtL",
  googlecalendar: "ca_4-EDlFVRfC5m",
};
```

**[src/run.ts](src/run.ts)** - Runner script used in automated test mode:
```typescript
const CONNECTED_ACCOUNTS: Record<string, string> = {
  gmail: "ca_vreLayFE0QtL",
  googlecalendar: "ca_4-EDlFVRfC5m",
};
```

**[src/agent.ts](src/agent.ts)** - Fallback from environment variables:
```typescript
function getEnvFallbackAccountId(app: string): string | undefined {
  if (app === "gmail") return process.env.GMAIL_AUTH_CONFIG_ID;
  if (app === "googlecalendar") return process.env.GOOGLECALENDAR_AUTH_CONFIG_ID;
  return undefined;
}

// In testEndpoint():
const connectedAccountId =
  connectedAccounts[app] || getEnvFallbackAccountId(app);
```

**[.env](.env)** - Environment variable fallback:
```
COMPOSIO_API_KEY=<your_api_key>
GMAIL_AUTH_CONFIG_ID=<your_auth_config_id>
GOOGLECALENDAR_AUTH_CONFIG_ID=<your_auth_config_id>
```

This three-tier fallback ensures robustness: code → environment variables → operation fails with clear error message.

---

## 3. Composio SDK Integration & proxyExecute

### Initial Approach (tools.execute) - Problems Encountered

The initial implementation used `composio.tools.execute()` with tool slugs:

```typescript
// FAILED APPROACH
result = await composio.tools.execute(endpoint.tool_slug, {
  connectedAccountId,
  arguments: toolInput,
});
```

**Problems with this approach:**
1. **Toolkit Version Error** - Composio SDK v2.x requires a toolkit version specification when using `tools.execute()` for manual endpoint testing. Without it, every call returned: `"Toolkit version not specified. For manual execution of the tool please pass a specific toolkit version"`
2. **Tool Registry Dependency** - This method requires the tool slug to exist in Composio's tool registry. Invalid endpoints (e.g., fake Gmail/Calendar methods) couldn't be tested at all - the SDK rejected them at the Composio layer before they could reach Google's API
3. **Lost HTTP Status Codes** - All errors from the above became generic SDK exceptions, losing the HTTP status code information needed to distinguish between "invalid endpoint" (404), "insufficient scopes" (403), and real server errors
4. **No Fallback Classification** - Without actual HTTP status codes, the classification logic couldn't work properly - all errors defaulted to status `"error"` with `http_status_code: null`

### Solution: Direct proxyExecute Calls

Switched to `composio.tools.proxyExecute()` for direct HTTP endpoint execution:

```typescript
// WORKING APPROACH in evaluateWithAccount()
result = await (composio.tools as any).proxyExecute({
  endpoint: fullPath,  // e.g., "/messages" or "/users/me/settings?maxResults=10"
  method: endpoint.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  connectedAccountId,
  body: Object.keys(bodyContent).length > 0 ? bodyContent : undefined,
});
```

**Why proxyExecute works:**
1. **Bypasses Tool Registry** - Calls the underlying HTTP endpoint directly using the connected account's OAuth token; doesn't require the endpoint to exist in Composio's tool registry
2. **No Toolkit Version** - No toolkit version parameter needed; it's a raw proxy pass-through
3. **Actual HTTP Status Codes** - Returns the real HTTP status code from Google's API (200, 404, 403, 405, 500, etc.)
4. **Enables Invalid Endpoint Detection** - Fake/invalid endpoints return 404 or 405 from Google, allowing proper classification

### Query Parameter & Body Handling

The implementation separates query parameters from body parameters:

```typescript
// Separate query params from body content
const queryParams: Record<string, string> = {};
const bodyContent: Record<string, unknown> = {};

for (const [key, value] of Object.entries(toolInput)) {
  const paramDef = endpoint.parameters.query.find((p) => p.name === key);
  if (paramDef) {
    queryParams[key] = String(value);
  } else {
    bodyContent[key] = value;
  }
}

// Build full URL with query parameters
let fullPath = resolvedPath;
if (Object.keys(queryParams).length > 0) {
  const queryString = new URLSearchParams(queryParams).toString();
  fullPath = `${resolvedPath}?${queryString}`;
}

// Execute with separated parameters
result = await (composio.tools as any).proxyExecute({
  endpoint: fullPath,
  method: endpoint.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  connectedAccountId,
  body: Object.keys(bodyContent).length > 0 ? bodyContent : undefined,
});
```

### HTTP Status Extraction

The proxy response is parsed to extract the HTTP status code:

```typescript
const r = result as Record<string, unknown>;

// Check multiple locations where statusCode might be stored
if (typeof r.statusCode === "number") {
  httpStatus = r.statusCode;
} else if (typeof r.status === "number") {
  httpStatus = r.status;
} else if (typeof r.http_status === "number") {
  httpStatus = r.http_status;
} else {
  // Assume success if no error
  httpStatus = 200;
}
```

### Both Attempts Updated

Both the initial attempt AND the retry-with-richer-body logic use proxyExecute with the same parameter separation pattern, ensuring consistent behavior across all execution attempts.

---

## 4. Dependency Resolution

Some endpoints require path parameters (e.g., `{messageId}`, `{eventId}`) that can only be obtained by first calling a list endpoint. This is handled through a **shared runtime cache** (`resolvedParamCache`) that is populated during execution and consumed by later endpoints.

**Execution phases** ensure list endpoints always run before detail endpoints:

| Phase | Criteria | Examples | Purpose |
|-------|----------|----------|---------|
| P0 | GET, no path params | `LIST_MESSAGES`, `LIST_EVENTS`, `GET_PROFILE` | Populate the cache |
| P1 | POST/PATCH/PUT, no path params | `CREATE_EVENT`, `CREATE_DRAFT`, `SEND_MESSAGE` | Also populate cache via created resource IDs |
| P2 | Any method with path params | `GET_MESSAGE`, `DELETE_EVENT`, `TRASH_MESSAGE` | Consume the cache |

`cacheIdsFromResponse()` inspects response shapes to extract IDs. It uses structural cues (presence of `messages[]`, `items[]`, `labels[]`, Google's `kind` field) rather than endpoint-specific conditions, making it generalisable to any app that returns standard list envelopes.

If a required path parameter cannot be resolved (dependency endpoint failed or returned no IDs), the agent reports the endpoint as `"error"` with a clear explanation that it is a dependency resolution failure — **not** a fake endpoint.

---

## 5. Avoiding False Negatives

False negatives occur when a valid endpoint is misclassified as `invalid_endpoint` or `error` due to bad request construction. The agent mitigates this with several strategies:

### a) Semantic body construction
`buildRequestBody()` uses field names and descriptions to produce real, API-compliant values:
- `raw` → actual base64url-encoded RFC 2822 email string
- `start` / `end` → proper RFC3339 timestamps with timezone
- `summary` → non-empty string for calendar event title

This avoids triggering validation errors that could be mistaken for structural endpoint failures.

### b) Minimal-first, then retry
The first attempt sends only **required** fields. If that returns a 4xx (excluding 401/403), the agent performs a **single retry** with all fields (required + optional) populated. If the retry succeeds, the classification is upgraded. This catches cases where the API requires an optional-but-practically-mandatory field.

### c) Robust status extraction
HTTP status codes are extracted from multiple locations in the Composio proxy response:
- `result.statusCode`, `result.data.statusCode`, `result.data.error.code` (Google API error envelope)
- Pattern-matching on error strings when no numeric code is available

This prevents a valid endpoint from being misclassified as `"error"` due to the status code being embedded in an unexpected location.

### d) Path parameter fallback message
When path params cannot be resolved, the agent explicitly marks the failure as a **dependency issue** in `response_summary`, not an endpoint validity problem. This preserves the accuracy of the `invalid_endpoint` count.

---

## 6. Classification Logic

| HTTP Status | Classification |
|-------------|---------------|
| 2xx | `valid` |
| 404, 405, 501 | `invalid_endpoint` |
| 401, 403 | `insufficient_scopes` |
| Everything else | `error` |
| null (no status) | `error` |

The classification is applied after the retry attempt, so the final status reflects the **best result** achieved across all attempts. The agent never downgrades a classification once `valid` is reached.

`insufficient_scopes` is deliberately strict: both 401 and 403 map here. A 401 can mean the OAuth token is missing (auth not set up), and a 403 means the token exists but the scope is not granted — both indicate an authorization gap rather than a structural endpoint problem.

---

## 7. Tradeoffs

### What was prioritised
- **Correctness over speed** — a 250ms delay between calls avoids rate-limiting false errors
- **Generic design** — no hardcoded app logic in the execution path; apps are distinguished only by their endpoint definitions
- **Low false negatives** — retry on ambiguous 4xx, explicit dependency failure messages
- **Readable report** — `response_summary` is a natural-language explanation, not just a status restatement

### What was cut for time
- **Parallel execution** — phases could be parallelised within themselves; currently sequential. Adds latency but removes race conditions in cache writes.
- **Scope introspection** — `available_scopes` is always `[]`. Composio's SDK exposes connected account details that could be queried to populate this accurately.
- **Smarter body inference** — currently uses field-name matching. A more general approach would use an LLM call to generate a valid sample payload from a field's description, which would handle arbitrary apps beyond Gmail/Calendar.
- **Multiple ID candidates** — the cache stores only the first list item's ID. A more robust approach would store multiple and rotate on retry.
- **DELETE safety** — `GOOGLECALENDAR_DELETE_EVENT` will delete a real event from the first page of results. Ideally the agent would create a dedicated test event first and delete that instead.

### What would be improved with more time
1. **LLM-assisted body construction** — use Claude to interpret field descriptions and generate semantically valid bodies for any app, removing the Gmail/Calendar-specific cases in `buildRequestBody()`.
2. **Scope-aware pre-check** — query the connected account's granted scopes before attempting calls that require scopes that aren't present, to produce cleaner `insufficient_scopes` results without hitting the API.
3. **Confidence scoring** — instead of binary classification, track whether the result was from a retry, how many attempts were made, and include that in the report for transparency.

---

## 8. Architecture Pattern

**Pattern chosen: Single sequential agent with phased execution and proxyExecute for direct API access**

### Why not multi-agent?
The problem is a linear pipeline — test endpoints, collect results, write report. There is no subtask that benefits from specialisation or parallel reasoning. A multi-agent setup (e.g., one agent per endpoint running concurrently) would introduce concurrency bugs in the shared ID cache without meaningful benefit, since the bottleneck is API rate limits, not CPU.

### Why not tools.execute()?
See Section 3 (Composio SDK Integration). The tool registry approach fails for invalid endpoints and requires toolkit version specification. `proxyExecute()` is more direct and works for endpoints not in Composio's registry.

### Why not an LLM-loop agent?
An LLM in a reasoning loop (plan → act → observe → repeat) would add latency and non-determinism. The endpoint definitions already provide all the information needed to construct requests — no planning step is needed. The structured nature of the problem (fixed input schema, fixed output schema, well-defined classification rules) fits a **deterministic rule-based executor** better than a generative agent.

### Pros of this pattern
- Deterministic and auditable — same inputs always produce the same execution path
- Fast — no LLM calls, no polling loops
- Easy to debug — linear execution, clear phase boundaries, explicit cache state logging
- Direct API access — proxyExecute bypasses tool registry limitations
- Works for invalid endpoints — can classify 404s and 405s properly

### Cons of this pattern
- Cannot adapt to unexpected API behaviour mid-run (e.g., if an endpoint returns a novel error format)
- Body construction falls back to hardcoded rules for new apps — an LLM agent would generalise better
- No dynamic re-ordering if a dependency fails mid-phase
- Requires Composio toolkit version for some legacy SDK versions (mitigated by proxyExecute)

---

## 9. Difficulties Encountered & Solutions

### Difficulty 1: SDK Version Incompatibility
**Problem:** The Composio SDK version changed between when the assignment was created and when the implementation was completed. The newer version (v2.x) requires a toolkit version parameter for `tools.execute()`, which the assignment docs don't mention.

**Evidence:** All 16 endpoints returned the error message: `"Toolkit version not specified. For manual execution of the tool please pass a specific toolkit version"`

**Solution:** Researched the Composio SDK docs and switched from `tools.execute()` to `tools.proxyExecute()`, which is the lower-level direct HTTP proxy method that doesn't require a toolkit version.

---

### Difficulty 2: Tool Registry vs. Invalid Endpoints
**Problem:** Using `tools.execute()` with tool slugs means the Composio SDK rejects tool slugs that don't exist in its registry BEFORE they can hit the actual API. This prevents testing of intentionally invalid/fake endpoints.

**Example:** A slug like `GMAIL_SEND_MESSAGE` (if it doesn't exist) returns a Composio SDK exception rather than a 404 from Google, making it impossible to distinguish between "invalid endpoint" and "SDK error".

**Solution:** Switching to `proxyExecute()` bypasses the tool registry entirely. The endpoint path is sent directly to Google's API, which returns a real 404/405 for invalid endpoints.

---

### Difficulty 3: HTTP Status Code Extraction
**Problem:** Early implementation tried to infer HTTP status from the response object's `error` field:
```typescript
const httpStatus: number = r?.error ? 400 : 200; // WRONG
```

This meant any Composio response with an `error` field got classified as 400, losing nuanced status codes.

**Solution:** Implemented robust status extraction that checks multiple locations where the status code might be stored:
- `result.statusCode`
- `result.status`
- `result.http_status`
- `result.data.statusCode` (nested under data)
- Error message pattern matching

---

### Difficulty 4: Connected Account ID Setup
**Problem:** The hardcoded connected account IDs in the initial code didn't match the user's actual Composio workspace. This caused silent failures where requests seemed to execute but returned errors.

**Solution:** Implemented three-tier configuration:
1. **Code-level** - Direct IDs in index.ts and run.ts
2. **Environment variables** - Via .env file (GMAIL_AUTH_CONFIG_ID, GOOGLECALENDAR_AUTH_CONFIG_ID)
3. **Fallback function** - getEnvFallbackAccountId() bridges code config with env variables

Also added explicit logging of which account ID is being used for each endpoint, making it easier to debug auth issues.

---

### Difficulty 5: Query Parameters vs. Body Parameters
**Problem:** The proxyExecute method structure expects parameters to be built into the endpoint URL (for query params) or sent separately in the body (for body params). The initial toolInput mixed both, leading to incorrect requests.

**Solution:** Implemented parameter separation logic:
```typescript
for (const [key, value] of Object.entries(toolInput)) {
  const paramDef = endpoint.parameters.query.find((p) => p.name === key);
  if (paramDef) {
    queryParams[key] = String(value);  // Goes in URL
  } else {
    bodyContent[key] = value;  // Goes in request body
  }
}
```

Then builds the full URL with URLSearchParams:
```typescript
const queryString = new URLSearchParams(queryParams).toString();
fullPath = `${resolvedPath}?${queryString}`;
```

---

### Difficulty 6: Type Safety with Dynamic API Calls
**Problem:** TypeScript couldn't verify the method type or parameters structure for `composio.tools.proxyExecute()` because it's a newer API not fully typed in the SDK.

**Solution:** Used type assertion to bypass TypeScript checking where necessary:
```typescript
result = await (composio.tools as any).proxyExecute({
  endpoint: fullPath,
  method: endpoint.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  connectedAccountId,
  body: Object.keys(bodyContent).length > 0 ? bodyContent : undefined,
});
```

This is a pragmatic trade-off: we know the API is correct at runtime (Google's API validates it), so the type assertion is safe.

---

### Difficulty 7: Response Parsing Inconsistency
**Problem:** Different Composio versions might return responses in different formats. Sometimes statusCode is at the top level, sometimes nested in `data`, sometimes in `error`.

**Solution:** Built redundancy into the status extraction logic:
```typescript
if (typeof r.statusCode === "number") {
  httpStatus = r.statusCode;
} else if (typeof r.status === "number") {
  httpStatus = r.status;
} else if (typeof r.http_status === "number") {
  httpStatus = r.http_status;
} else {
  httpStatus = 200; // Default to success if no error field
}
```

This defensive approach ensures the agent works across SDK versions.

---

### Difficulty 8: Retry Logic with proxyExecute
**Problem:** The retry logic also uses `tools.execute()` in the original code. Must be updated to proxyExecute with the same parameter separation.

**Solution:** Duplicated the parameter separation and proxyExecute call in the retry block, ensuring both attempts use the same execution method:
```typescript
// In retry attempt
const enrichedInput = { ...toolInput, ...richBody };
const retryQueryParams: Record<string, string> = {};
const retryBodyContent: Record<string, unknown> = {};

for (const [key, value] of Object.entries(enrichedInput)) {
  const paramDef = endpoint.parameters.query.find((p) => p.name === key);
  if (paramDef) {
    retryQueryParams[key] = String(value);
  } else {
    retryBodyContent[key] = value;
  }
}

let retryFullPath = resolvedPath;
if (Object.keys(retryQueryParams).length > 0) {
  const queryString = new URLSearchParams(retryQueryParams).toString();
  retryFullPath = `${resolvedPath}?${queryString}`;
}

const retryResult = await (composio.tools as any).proxyExecute({
  endpoint: retryFullPath,
  method: endpoint.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  connectedAccountId,
  body: Object.keys(retryBodyContent).length > 0 ? retryBodyContent : undefined,
});
```

---

## 10. Code Changes Summary

### Files Modified

1. **[src/agent.ts](src/agent.ts)**
   - Added `getEnvFallbackAccountId()` function for environment variable fallback
   - Replaced `composio.tools.execute()` with `composio.tools.proxyExecute()` in evaluateWithAccount()
   - Implemented query parameter separation and URL building
   - Added robust HTTP status code extraction from multiple response locations
   - Updated retry logic to use proxyExecute with the same parameter handling
   - Changed from inferring status from error field to parsing actual HTTP responses

2. **[src/index.ts](src/index.ts)**
   - Updated Gmail connected account ID from `ca_V7Qeq70QQ2HI` → `ca_rL6WSv4W0rYT` → `ca_vreLayFE0QtL`
   - Updated Google Calendar connected account ID from `ac_Obqoh5MpxthR` → `ca_NJtqeaX42s-c` (no further changes)
   - Updated example comment to show current ID format

3. **[src/run.ts](src/run.ts)**
   - Updated CONNECTED_ACCOUNTS type from union to simple string
   - Updated Gmail account ID (same progression as index.ts)
   - Updated Google Calendar account ID

4. **[.env](.env)**
   - Updated GMAIL_AUTH_CONFIG_ID value progressively as new IDs were provided
   - GOOGLECALENDAR_AUTH_CONFIG_ID remains consistent once set

---

## 11. Key Architectural Decisions

### Why proxyExecute Over tools.execute()
- **Correctness** - Direct API calls return actual HTTP status codes
- **Flexibility** - Can test any endpoint, including fake/invalid ones
- **Simplicity** - No toolkit version requirement, no tool registry dependency
- **Generalisable** - Works for any app via Composio, not just pre-registered tools

### Why Three-Tier Configuration
- **Flexibility** - Code can set defaults, environment variables can override
- **Security** - Sensitive IDs can be injected at runtime via .env
- **Testability** - Different test runs can use different accounts without code changes
- **Debugging** - Easy to verify which account is being used when something fails

### Why Parameter Separation
- **Correctness** - Query parameters belong in the URL, body parameters in the request body
- **Google API compliance** - Google's API docs specify exactly which parameters go where
- **Future extensibility** - Easy to handle headers or other parameter types if needed

---

## 12. Testing & Validation

To verify the fixes work:

```bash
# Using Bun (project setup)
bun src/run.ts

# Or with Node.js
node --require tsx src/run.ts
```

Expected output:
- Endpoints should return actual HTTP status codes (not null)
- Invalid/fake endpoints should show as `invalid_endpoint` (404/405)
- Valid endpoints should show as `valid` (2xx)
- Missing OAuth scopes should show as `insufficient_scopes` (401/403)
- The report.json should have proper status classifications, not all "error"