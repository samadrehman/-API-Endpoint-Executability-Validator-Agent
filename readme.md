# API Endpoint Executability Validator Agent

## Overview
An AI agent that automates verification of API endpoint executability. Validates that endpoints can be successfully called, handles authentication, and classifies responses.

## Prerequisites
- Node.js/Bun runtime
- Composio account with API key
- Gmail and Google Calendar connected accounts

## Setup Instructions

### 1. Install Dependencies
```bash
bun install
```

### 2. Configure Environment Variables
Create a `.env` file in the root directory (or run `sh setup.sh` to generate one):
```
COMPOSIO_API_KEY=<your_composio_api_key>
GMAIL_AUTH_CONFIG_ID=<gmail_auth_config_id>
GOOGLECALENDAR_AUTH_CONFIG_ID=<google_calendar_auth_config_id>
GMAIL_CONNECTED_ACCOUNT_ID=<gmail_connected_account_id>
GOOGLECALENDAR_CONNECTED_ACCOUNT_ID=<google_calendar_connected_account_id>
```

### 3. Run Setup Script
```bash
sh setup.sh
```
This installs dependencies, creates `.env` (if missing), and checks whether required values are present.

### 4. Add Your Real Credentials
Edit `.env` and set real values for:
- `COMPOSIO_API_KEY`
- `GMAIL_AUTH_CONFIG_ID`
- `GOOGLECALENDAR_AUTH_CONFIG_ID`
- `GMAIL_CONNECTED_ACCOUNT_ID`
- `GOOGLECALENDAR_CONNECTED_ACCOUNT_ID`

## Running the Tool

### Quick Start - Display Endpoints
```bash
bun src/index.ts
```
Shows a summary of all available Gmail and Google Calendar endpoints.

### Run Full Test Agent
```bash
bun src/run.ts
```
Executes the agent to test all endpoints and generates a detailed `report.json` with results.

## Add New Endpoint (Short Guide)

Add new tests in `src/endpoints.json` by following the same object format.

1. Pick the app block: `gmail` or `googlecalendar`.
2. Add a new object inside its `endpoints` array.
3. Fill these required keys:
    - `tool_slug` (unique name, usually uppercase)
    - `description`
    - `method` (`GET`, `POST`, `PATCH`, `PUT`, `DELETE`)
    - `path` (use `{id}` placeholders for path params)
    - `required_scopes` (array)
    - `parameters` with:
       - `query`: array of query parameter definitions
       - `path`: array of path parameter definitions
       - `body`: `null` for no body, otherwise include `content_type` and `fields`
4. Keep parameter definition shape consistent:
    - `name`, `type`, `required`, `description`
5. Run `bun src/index.ts` to verify endpoint listing.
6. Run `bun src/run.ts` to test execution and classification.

Example (minimal GET endpoint):

```json
{
   "tool_slug": "GOOGLECALENDAR_GET_PRIMARY_CALENDAR",
   "description": "Returns metadata for the user's primary calendar.",
   "method": "GET",
   "path": "/calendar/v3/calendars/primary",
   "required_scopes": ["https://www.googleapis.com/auth/calendar.readonly"],
   "parameters": {
      "query": [],
      "path": [],
      "body": null
   }
}
```

## Output
The test report is saved to `report.json` with:
- Endpoint status (valid, invalid_endpoint, insufficient_scopes, error)
- HTTP status codes
- Response summaries and bodies
- Summary counts for each status category

## Endpoint Classification
- **valid** — Endpoint returned 2xx response
- **invalid_endpoint** — Endpoint doesn't exist (404, method not allowed)
- **insufficient_scopes** — Auth failed (403, permission denied)
- **error** — Other runtime issues
|-----------|----------|-------------|
| `endpoint` | Yes | API path (e.g., `/gmail/v1/users/me/messages`) |
| `method` | Yes | `"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, or `"PATCH"` |
| `connectedAccountId` | Yes | Use `"candidate"` (set up during `setup.sh`) |
| `parameters` | No | Array of `{ in: "query" \| "header", name, value }` |
| `body` | No | Request body object for POST/PUT/PATCH |

**Response structure:**

```typescript
interface ProxyExecuteResponse {
  status: number;                        // HTTP status code (200, 404, 403, etc.)
  data?: unknown;                        // Response body (JSON)
  headers?: Record<string, string>;      // Response headers
}
```

Use `result.status` to classify endpoints: 2xx = valid, 404 = invalid, 403 = insufficient scopes, etc.

**Important:**
- **Do NOT make raw HTTP requests** or extract bearer tokens manually. `proxyExecute()` handles all auth.
- **Path parameters** (like `{messageId}`) must be substituted into the path string before calling. `proxyExecute` only handles query and header params.
- **OAuth, token refresh, and rate limits** are handled by Composio — these are out of scope for your agent.
- **Your agent will take real actions** on the connected Google account (send emails, trash messages, create/delete calendar events). Use a secondary or throwaway Google account if possible.

## Classification

| Status | Meaning | Typical signals |
|--------|---------|-----------------|
| `valid` | Endpoint exists and can be successfully executed | Any 2xx response (200, 201, 204, etc.) |
| `invalid_endpoint` | Endpoint does not exist | 404, "not found", method not allowed |
| `insufficient_scopes` | Endpoint exists but account lacks permissions | 403, "forbidden", "insufficient permissions" |
| `error` | Something else went wrong | 400, 500, timeouts, malformed responses |


## Dependency resolution

Some endpoints need data from other endpoints. For example:

```
GET /gmail/v1/users/me/messages/{messageId}
```

Your agent can't just make up a `messageId`. It needs to:
1. Recognize that `{messageId}` is a path parameter
2. Find another endpoint that can provide a valid message ID (e.g., `GET /messages` → pick an ID from the response)
3. Substitute the real ID into the path
4. Then call the endpoint

This "list → pick item → use in detail request" pattern appears across most APIs. Your agent should handle it generically — not just for Gmail messages, but for any resource type in any app.

## Architecture

**One AI agent per endpoint** — each endpoint should be tested by its own AI agent instance. Don't use a single agent that sequentially loops through all endpoints.

**No hardcoded execution order** — AI agents should run in any order (or concurrently). If an AI agent needs data from another endpoint, it resolves that dependency dynamically.

**Think about how your AI agent avoids its own mistakes.** The biggest risk isn't fake endpoints — it's your AI agent misusing valid endpoints (wrong params, bad payload) and then misclassifying them as invalid. Good architectures have strategies for this:
- How does the AI agent construct valid requests from the parameter definitions?
- How does it distinguish "this endpoint doesn't exist" from "I called it wrong"?
- Does it retry with different parameters before giving up?




### Tech stack

Use **Bun** (not Node.js). The project is already set up for Bun. 

## Getting Started

1. **Get your Composio API key** from [platform.composio.dev](https://platform.composio.dev) (free account).

2. **Run the setup script:**
   ```bash
   COMPOSIO_API_KEY=<your_key> sh setup.sh
   ```
   This installs dependencies, creates auth configs, connects your Google account via OAuth, and runs a sanity check to verify `proxyExecute()` works. The connected account ID is `"candidate"`.

3. **Explore the sample endpoints:**
   ```bash
   bun src/index.ts
   ```

4. **Implement your agent** in `src/agent.ts` (see type definitions in `src/types.ts`).

5. **Run and validate:**
   ```bash
   bun src/run.ts
   ```
   This calls your `runAgent()`, validates the output, and writes `report.json`.

6. **Write your architecture doc** in `ARCHITECTURE.md`.

## Project Structure

```
src/
├── agent.ts          <- YOUR IMPLEMENTATION GOES HERE
├── types.ts          <- Input/output type definitions (do not modify)
├── run.ts            <- Runner that calls your agent and validates output (do not modify)
├── endpoints.json    <- Sample endpoint definitions (Gmail + Google Calendar)
├── index.ts          <- Prints a summary of endpoints
└── connect.ts        <- Google OAuth connection setup
ARCHITECTURE.md       <- YOUR ARCHITECTURE DOC (create this)
```

### How the runner works

1. `run.ts` loads endpoints from `endpoints.json` and passes them to your `runAgent()` function along with an authenticated Composio client.
2. Your `runAgent()` tests each endpoint and returns a `TestReport`.
3. `run.ts` validates the report (all endpoints covered, valid statuses, summary counts match) and writes `report.json`.

You can create additional files and modules — just keep `runAgent()` in `agent.ts` as the entry point.

## Output format

Your agent returns a `TestReport` (see `src/types.ts`). The report JSON looks like:

```json
{
  "timestamp": "2026-03-25T10:00:00.000Z",
  "total_endpoints": 16,
  "results": [
    {
      "tool_slug": "GMAIL_LIST_MESSAGES",
      "method": "GET",
      "path": "/gmail/v1/users/me/messages",
      "status": "valid",
      "http_status_code": 200,
      "response_summary": "Returned list of messages successfully",
      "response_body": { "messages": [{ "id": "19d1b2ff8f72b035", "threadId": "19d1b2fc48ac0f35" }], "resultSizeEstimate": 201 },
      "required_scopes": ["https://www.googleapis.com/auth/gmail.readonly"],
      "available_scopes": ["https://www.googleapis.com/auth/gmail.readonly"]
    }
  ],
  "summary": {
    "valid": 13,
    "invalid_endpoint": 2,
    "insufficient_scopes": 1,
    "error": 0
  }
}
```

