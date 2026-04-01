import { Composio } from "@composio/core";
import type {
  EndpointDefinition,
  EndpointReport,
  EndpointStatus,
  TestReport,
} from "./types";


// Resolved parameter cache (filled during execution)
// e.g. { messageId: "17abc...", eventId: "abcdef..." }

const resolvedParamCache: Record<string, string> = {};


// HTTP Status Classification

function classifyByHttpStatus(
  httpStatus: number | null,
  errorBody: unknown
): EndpointStatus {
  if (httpStatus === null) return "error";
  if (httpStatus >= 200 && httpStatus < 300) return "valid";
  if (httpStatus === 401 || httpStatus === 403) return "insufficient_scopes";
  return "error";
}


// Extract HTTP status from Composio proxy response
// Composio wraps the underlying HTTP call; the status may live
// in several places depending on the SDK version and error type.

function extractHttpStatus(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;

  const r = result as Record<string, unknown>;

  // Direct status code fields
  if (typeof r.statusCode === "number") return r.statusCode;
  if (typeof r.status === "number") return r.status;
  if (typeof r.http_status === "number") return r.http_status;

  // Composio SDK sometimes puts it in data
  if (r.data && typeof r.data === "object") {
    const d = r.data as Record<string, unknown>;
    if (typeof d.statusCode === "number") return d.statusCode;
    if (typeof d.status === "number") return d.status;

    // Google API error envelope: { error: { code: 404, ... } }
    if (d.error && typeof d.error === "object") {
      const e = d.error as Record<string, unknown>;
      if (typeof e.code === "number") return e.code;
    }
  }

  // Error object
  if (r.error && typeof r.error === "object") {
    const e = r.error as Record<string, unknown>;
    if (typeof e.code === "number") return e.code;
    if (typeof e.statusCode === "number") return e.statusCode;
    if (typeof e.status === "number") return e.status;
  }

  if (typeof r.error === "string") {
    // Parse status from error string
    const match = r.error.match(/\b(4\d{2}|5\d{2})\b/);
    if (match) return parseInt(match[1], 10);
    if (/not found/i.test(r.error)) return 404;
    if (/forbidden|permission denied/i.test(r.error)) return 403;
    if (/unauthorized/i.test(r.error)) return 401;
  }

  // If data exists with no error-like fields, assume 2xx
  if (r.data !== undefined && r.error === undefined) return 200;
  if (r.data !== undefined && r.data !== null && r.error === null) return 200;

  return null;
}


// Extract HTTP status from a thrown Error object

function extractStatusFromError(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);

  // Numeric code in message
  const match = msg.match(/\b(4\d{2}|5\d{2})\b/);
  if (match) return parseInt(match[1], 10);

  if (/not found/i.test(msg)) return 404;
  if (/forbidden|permission denied/i.test(msg)) return 403;
  if (/unauthorized/i.test(msg)) return 401;
  if (/method not allowed/i.test(msg)) return 405;

  return null;
}


// Cache IDs extracted from successful list responses
// This powers dependency resolution for path-param endpoints.

function cacheIdsFromResponse(
  responseData: unknown,
  endpoint: EndpointDefinition
): void {
  if (!responseData || typeof responseData !== "object") return;
  const d = responseData as Record<string, unknown>;

  // Gmail
  if (Array.isArray(d.messages) && d.messages.length > 0) {
    const first = d.messages[0] as Record<string, unknown>;
    if (first?.id) resolvedParamCache["messageId"] = String(first.id);
    if (first?.threadId)
      resolvedParamCache["threadId"] = String(first.threadId);
  }
  if (Array.isArray(d.threads) && d.threads.length > 0) {
    const first = d.threads[0] as Record<string, unknown>;
    if (first?.id) resolvedParamCache["threadId"] = String(first.id);
  }
  if (Array.isArray(d.labels) && d.labels.length > 0) {
    const first = d.labels[0] as Record<string, unknown>;
    if (first?.id) resolvedParamCache["labelId"] = String(first.id);
  }
  if (Array.isArray(d.drafts) && d.drafts.length > 0) {
    const first = d.drafts[0] as Record<string, unknown>;
    if (first?.id) resolvedParamCache["draftId"] = String(first.id);
  }

  // Google Calendar
  if (Array.isArray(d.items) && d.items.length > 0) {
    for (const item of d.items as Record<string, unknown>[]) {
      if (item?.id) {
        // Calendar list entry vs event entry: calendar list items have 'summary' or 'kind'
        const kind = String(item.kind ?? "");
        if (kind.includes("calendar#calendarListEntry")) {
          resolvedParamCache["calendarId"] = String(item.id);
        } else {
          resolvedParamCache["eventId"] = String(item.id);
          break;
        }
      }
    }
  }

  // Single-object responses with 'id' (e.g., after creating an event/draft)
  if (typeof d.id === "string" && d.id.length > 0) {
    const path = endpoint.path.toLowerCase();
    if (path.includes("/events")) resolvedParamCache["eventId"] = d.id;
    else if (path.includes("/messages")) resolvedParamCache["messageId"] = d.id;
    else if (path.includes("/drafts")) resolvedParamCache["draftId"] = d.id;
    else if (path.includes("/threads")) resolvedParamCache["threadId"] = d.id;
    else if (path.includes("/labels")) resolvedParamCache["labelId"] = d.id;
  }
}


// Substitute path parameters into the path template
// Returns null if a required param is unresolvable.

function resolvePathParams(endpoint: EndpointDefinition): string | null {
  let resolved = endpoint.path;

  for (const param of endpoint.parameters.path) {
    const placeholder = `{${param.name}}`;
    if (!resolved.includes(placeholder)) continue;

    const cached = resolvedParamCache[param.name];
    if (!cached) {
      console.log(
        `    ⚠ No cached value for path param "${param.name}" — skipping ${endpoint.tool_slug}`
      );
      return null;
    }
    resolved = resolved.replace(placeholder, encodeURIComponent(cached));
  }

  return resolved;
}


// Build a minimal but valid request body for
// POST/PUT/PATCH endpoints based on field definitions.
// Uses semantics from field names + descriptions to
// produce real values rather than generic stubs.

function buildRequestBody(
  endpoint: EndpointDefinition
): Record<string, unknown> | null {
  const bodyDef = endpoint.parameters.body;
  if (!bodyDef || bodyDef.fields.length === 0) return null;

  const body: Record<string, unknown> = {};
  const now = new Date();
  const later = new Date(now.getTime() + 60 * 60 * 1000); // +1 hour

  // Helper: make base64url-encoded RFC 2822 email
  const makeRawEmail = (subject: string) => {
    const msg = [
      "MIME-Version: 1.0",
      "From: agent-test@example.com",
      "To: agent-test@example.com",
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Automated endpoint test message. Please ignore.",
    ].join("\r\n");

    // btoa is available in Bun
    return btoa(msg).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  };

  for (const field of bodyDef.fields) {
    // Only required fields — avoids polluting requests with optional junk
    if (!field.required) continue;

    const name = field.name;
    const descLower = field.description.toLowerCase();

    //─ Gmail-specific─
    if (name === "raw") {
      body[name] = makeRawEmail("[Agent Test] Endpoint Validation");
      continue;
    }

    if (name === "message" && descLower.includes("raw")) {
      body[name] = {
        raw: makeRawEmail("[Agent Test] Draft Validation"),
      };
      continue;
    }

    //─ Google Calendar-specific
    if (name === "summary") {
      body[name] = "[Agent Test] Endpoint Validation Event";
      continue;
    }

    if (name === "start") {
      body[name] = {
        dateTime: now.toISOString(),
        timeZone: "UTC",
      };
      continue;
    }

    if (name === "end") {
      body[name] = {
        dateTime: later.toISOString(),
        timeZone: "UTC",
      };
      continue;
    }

    //─ Generic fallbacks based on type─
    switch (field.type) {
      case "string":
        body[name] = "test-value";
        break;
      case "integer":
      case "number":
        body[name] = 1;
        break;
      case "boolean":
        body[name] = true;
        break;
      case "object":
        body[name] = {};
        break;
      case "array":
        body[name] = [];
        break;
      default:
        body[name] = "test-value";
    }
  }

  return Object.keys(body).length > 0 ? body : null;
}


function buildToolInput(endpoint: EndpointDefinition): Record<string, any> {
  const input: Record<string, any> = {};

  // Path params
  for (const param of endpoint.parameters.path) {
    const val = resolvedParamCache[param.name];
    if (val) input[param.name] = val;
  }

  // Query params
  for (const param of endpoint.parameters.query) {
    if (param.required) {
      input[param.name] = param.type === "integer" ? 5 : "test";
    }
  }

  // Body
  const body = buildRequestBody(endpoint);
  if (body) {
    Object.assign(input, body);
  }

  return input;
}


// Truncate + redact response bodies before storing
// in the report (no emails, IDs kept for debugging).

function sanitizeResponseBody(body: unknown, maxLen = 2000): unknown {
  if (body === null || body === undefined) return body;

  if (typeof body === "string") {
    return body.length > maxLen ? body.slice(0, maxLen) + "…[truncated]" : body;
  }

  try {
    const str = JSON.stringify(body);
    if (str.length <= maxLen) return body;

    // Try to create a truncated but structurally valid version
    const obj = body as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) {
        out[`${k}[count]`] = v.length;
        out[k] = v.slice(0, 2); // keep first 2 items for context
      } else if (typeof v === "string" && v.length > 300) {
        out[k] = v.slice(0, 300) + "…";
      } else {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return String(body).slice(0, maxLen);
  }
}


// Build a human-readable explanation for why an
// endpoint was classified the way it was.

function buildSummary(
  endpoint: EndpointDefinition,
  status: EndpointStatus,
  httpStatus: number | null,
  resolvedPath: string
): string {
  const method = endpoint.method;
  const code = httpStatus !== null ? `HTTP ${httpStatus}` : "no status code";

  switch (status) {
    case "valid":
      return (
        `Endpoint ${method} ${resolvedPath} returned a successful response (${code}). ` +
        `This confirms the endpoint exists and the connected account has sufficient access.`
      );

    case "invalid_endpoint":
      return (
        `Endpoint ${method} ${resolvedPath} returned ${code}, indicating it does not exist ` +
        `in the real API. This is likely a fake or deprecated endpoint definition.`
      );

    case "insufficient_scopes":
      return (
        `Endpoint ${method} ${resolvedPath} returned ${code}. ` +
        `The endpoint exists but the connected account lacks the required OAuth scopes: ` +
        `[${endpoint.required_scopes.join(", ")}].`
      );

    case "error":
    default:
      return (
        `Endpoint ${method} ${resolvedPath} failed with ${code}. ` +
        `This may indicate a server error, malformed request parameters, ` +
        `or a transient API issue. The endpoint's existence could not be confirmed.`
      );
  }
}


// Determine execution order:
//   Phase 0 — Simple GETs (no path params, no body)         → fills cache
//   Phase 1 — POST/PUT/PATCH (no path params)               → may fill cache
//   Phase 2 — GET/POST/DELETE with path params              → uses cache
// Within each phase, sort alphabetically by tool_slug for determinism.

function orderEndpoints(
  endpoints: EndpointDefinition[]
): EndpointDefinition[] {
  const hasPathParams = (ep: EndpointDefinition) =>
    ep.parameters.path.length > 0;

  const phase0 = endpoints.filter(
    (ep) =>
      ep.method === "GET" && !hasPathParams(ep)
  );
  const phase1 = endpoints.filter(
    (ep) => ["POST", "PUT", "PATCH"].includes(ep.method) && !hasPathParams(ep)
  );
  const phase2 = endpoints.filter((ep) => hasPathParams(ep));

  const alpha = (a: EndpointDefinition, b: EndpointDefinition) =>
    a.tool_slug.localeCompare(b.tool_slug);

  return [
    ...phase0.sort(alpha),
    ...phase1.sort(alpha),
    ...phase2.sort(alpha),
  ];
}


function getAppFromToolSlug(toolSlug: string): string {
  if (toolSlug.startsWith("GMAIL")) return "gmail";
  if (toolSlug.startsWith("GOOGLECALENDAR")) return "googlecalendar";
  return "unknown";
}

function getEnvFallbackAccountId(app: string): string | undefined {
  if (app === "gmail") return process.env.GMAIL_AUTH_CONFIG_ID;
  if (app === "googlecalendar") return process.env.GOOGLECALENDAR_AUTH_CONFIG_ID;
  return undefined;
}


// Core: test a single endpoint

async function testEndpoint(
  composio: Composio,
  connectedAccounts: Record<string, string>,
  endpoint: EndpointDefinition
): Promise<EndpointReport> {
  const hasPathParams = endpoint.parameters.path.length > 0;
  const app = getAppFromToolSlug(endpoint.tool_slug);
  const connectedAccountId =
    connectedAccounts[app] || getEnvFallbackAccountId(app);

  if (!connectedAccountId) {
    return {
      tool_slug: endpoint.tool_slug,
      method: endpoint.method,
      path: endpoint.path,
      status: "error",
      http_status_code: null,
      response_summary: `No connected account found for app "${app}".`,
      response_body: null,
      required_scopes: endpoint.required_scopes,
      available_scopes: [],
    };
  }

  //─ Resolve path parameters─
  let resolvedPath: string;

  if (hasPathParams) {
    const resolved = resolvePathParams(endpoint);
    if (resolved === null) {
      // Dependency not available — can't test, report as error with context
      return {
        tool_slug: endpoint.tool_slug,
        method: endpoint.method,
        path: endpoint.path,
        status: "error",
        http_status_code: null,
        response_summary:
          `Unable to test ${endpoint.method} ${endpoint.path}: required path ` +
          `parameter(s) [${endpoint.parameters.path.map((p) => p.name).join(", ")}] ` +
          `could not be resolved because no dependency endpoint provided them. ` +
          `This is a dependency resolution failure, not necessarily an invalid endpoint.`,
        response_body: null,
        required_scopes: endpoint.required_scopes,
        available_scopes: [],
      };
    }
    resolvedPath = resolved;
  } else {
    resolvedPath = endpoint.path;
  }

  //─ Build tool input─
  const toolInput = buildToolInput(endpoint);

  const evaluateWithAccount = async (
    connectedAccountId: string
  ): Promise<EndpointReport> => {
    //─ Separate query params and body from toolInput─
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

    //─ Build full URL with query parameters─
    let fullPath = resolvedPath;
    if (Object.keys(queryParams).length > 0) {
      const queryString = new URLSearchParams(queryParams).toString();
      fullPath = `${resolvedPath}?${queryString}`;
    }

    //─ Execute via proxyExecute (direct HTTP endpoint call)─
    let result: unknown;
    let httpStatus: number | null = null;
    let responseData: unknown = null;
    let rawBody: unknown = null;

    try {
      console.log(`    → Using account: ${connectedAccountId} (${app})`);
      result = await (composio.tools as any).proxyExecute({
        endpoint: fullPath,
        method: endpoint.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
        connectedAccountId,
        body: Object.keys(bodyContent).length > 0 ? bodyContent : undefined,
      });

      // Parse proxyExecute response
      const r = result as Record<string, unknown>;

      // Extract HTTP status from proxyExecute response
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

      responseData = r.data || r;
      rawBody = responseData;
    } catch (err) {
      // Thrown exceptions (network error, auth error, etc.)
      httpStatus = extractStatusFromError(err);
      const errMsg = err instanceof Error ? err.message : String(err);
      rawBody = sanitizeResponseBody(errMsg);

      if (httpStatus === null) {
        httpStatus = 500; // Network error
      }
    }

    const effectiveStatus = httpStatus;

    const status = classifyByHttpStatus(effectiveStatus, rawBody);

    //─ Cache IDs from successful responses─
    if (status === "valid" && responseData) {
      cacheIdsFromResponse(responseData, endpoint);
      // Also cache on partial success (some APIs return 2xx with items)
    }

    //─ If first attempt failed with 4xx that might be a param issue, retry once─
    // For example: a POST that got 400 might just need a better body.
    // We do a single retry with the full (including optional) fields populated.
    let finalStatus = status;
    let finalHttpStatus = effectiveStatus;
    let finalBody = rawBody;

    if (
      status === "error" &&
      effectiveStatus !== null &&
      effectiveStatus >= 400 &&
      effectiveStatus < 500 &&
      effectiveStatus !== 401 &&
      effectiveStatus !== 403 &&
      endpoint.parameters.body !== null
    ) {
      // Build a richer body with ALL fields (not just required)
      const richBody: Record<string, unknown> = {};
      const now = new Date();
      const later = new Date(now.getTime() + 60 * 60 * 1000);
      const makeRaw = () => {
        const m = [
          "MIME-Version: 1.0",
          "From: agent-test@example.com",
          "To: agent-test@example.com",
          "Subject: [Agent Test] Retry",
          "Content-Type: text/plain",
          "",
          "Retry test",
        ].join("\r\n");
        return btoa(m).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
      };

      for (const field of endpoint.parameters.body.fields) {
        switch (field.name) {
          case "raw":
            richBody[field.name] = makeRaw();
            break;
          case "message":
            richBody[field.name] = { raw: makeRaw() };
            break;
          case "summary":
            richBody[field.name] = "[Agent Test] Retry Event";
            break;
          case "start":
            richBody[field.name] = { dateTime: now.toISOString(), timeZone: "UTC" };
            break;
          case "end":
            richBody[field.name] = { dateTime: later.toISOString(), timeZone: "UTC" };
            break;
          case "description":
            richBody[field.name] = "Automated test";
            break;
          default:
            richBody[field.name] =
              field.type === "integer"
                ? 1
                : field.type === "boolean"
                ? true
                : field.type === "object"
                ? {}
                : field.type === "array"
                ? []
                : "test";
        }
      }

      try {
        console.log(`    → Using account: ${connectedAccountId} (${app})`);
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

        const rr = retryResult as unknown as Record<string, unknown>;
        let retryStatus: number | null = null;

        if (typeof rr.statusCode === "number") {
          retryStatus = rr.statusCode;
        } else if (typeof rr.status === "number") {
          retryStatus = rr.status;
        } else if (typeof rr.http_status === "number") {
          retryStatus = rr.http_status;
        } else {
          retryStatus = 200;
        }

        const retryData = rr.data || rr;
        const retryBody = retryData;
        const effectiveRetry = retryStatus;

        const retryClassified = classifyByHttpStatus(effectiveRetry, retryBody);

        if (retryClassified === "valid") {
          finalStatus = "valid";
          finalHttpStatus = effectiveRetry;
          finalBody = retryData;
          if (retryData) cacheIdsFromResponse(retryData, endpoint);
          console.log(`    ↩ Retry succeeded (HTTP ${effectiveRetry})`);
        } else if (
          retryClassified === "invalid_endpoint" ||
          retryClassified === "insufficient_scopes"
        ) {
          // More informative classification from retry
          finalStatus = retryClassified;
          finalHttpStatus = effectiveRetry;
          finalBody = retryBody;
        }
      } catch {
        // Retry failed too — keep original result
      }
    }

    return {
      tool_slug: endpoint.tool_slug,
      method: endpoint.method,
      path: endpoint.path,
      status: finalStatus,
      http_status_code: finalHttpStatus,
      response_summary: buildSummary(endpoint, finalStatus, finalHttpStatus, resolvedPath),
      response_body: sanitizeResponseBody(finalBody),
      required_scopes: endpoint.required_scopes,
      available_scopes: [],
    };
  };

  return evaluateWithAccount(connectedAccountId);
}


// Entry point

export async function runAgent(params: {
  composio: Composio;
  connectedAccounts: Record<string, string>;
  endpoints: EndpointDefinition[];
}): Promise<TestReport> {
  const { composio, connectedAccounts, endpoints } = params;

  console.log(`\n━━━ Endpoint Tester Agent ━━━`);
  console.log(`Testing ${endpoints.length} endpoints across all apps.\n`);
  console.log(
    `Execution order: Phase 0 (GET, no params) → Phase 1 (POST/PATCH, no params) → Phase 2 (path params)\n`
  );

  const ordered = orderEndpoints(endpoints);
  const originalOrder = endpoints.map((e) => e.tool_slug);
  const results: EndpointReport[] = [];

  for (let i = 0; i < ordered.length; i++) {
    const endpoint = ordered[i];
    const phase =
      endpoint.parameters.path.length > 0
        ? "P2"
        : ["POST", "PUT", "PATCH"].includes(endpoint.method)
        ? "P1"
        : "P0";

    console.log(
      `[${String(i + 1).padStart(2)}/${ordered.length}] [${phase}] ${endpoint.method.padEnd(6)} ${endpoint.path}`
    );

    const report = await testEndpoint(composio, connectedAccounts, endpoint);
    results.push(report);

    const icon =
      report.status === "valid"
        ? "✓"
        : report.status === "invalid_endpoint"
        ? "✗"
        : report.status === "insufficient_scopes"
        ? "⚠"
        : "?";

    console.log(
      `       ${icon} ${report.status.toUpperCase()} — HTTP ${report.http_status_code ?? "N/A"}`
    );

    // Small delay to be a good API citizen
    await new Promise((r) => setTimeout(r, 250));
  }

  // Restore original input order in the output report
  results.sort(
    (a, b) =>
      originalOrder.indexOf(a.tool_slug) - originalOrder.indexOf(b.tool_slug)
  );

  const summary = {
    valid: results.filter((r) => r.status === "valid").length,
    invalid_endpoint: results.filter((r) => r.status === "invalid_endpoint")
      .length,
    insufficient_scopes: results.filter(
      (r) => r.status === "insufficient_scopes"
    ).length,
    error: results.filter((r) => r.status === "error").length,
  };

  console.log(`\n━━━ Summary ━━━`);
  console.log(`  ✓ valid               ${summary.valid}`);
  console.log(`  ✗ invalid_endpoint    ${summary.invalid_endpoint}`);
  console.log(`  ⚠ insufficient_scopes ${summary.insufficient_scopes}`);
  console.log(`  ? error               ${summary.error}`);
  console.log(
    `\nCached param values: ${JSON.stringify(resolvedParamCache, null, 2)}`
  );

  return {
    timestamp: new Date().toISOString(),
    total_endpoints: endpoints.length,
    results,
    summary,
  };
}