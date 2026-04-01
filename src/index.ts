import { Composio } from "@composio/core";
import { runAgent } from "./agent";
import endpoints from "./endpoints.json";

// This file loads and displays the endpoint definitions you need to test.
// Use this as a starting point to understand the input data.
//
// Hint: Use composio.tools.execute() to test tool slugs. Example:
//   const connectedAccounts = {
//     gmail: "ca_vreLayFE0QtL",
//     googlecalendar: "ca_4-EDlFVRfC5m",
//   };
//   const connectedAccountId = connectedAccounts.gmail;
//   const result = await composio.tools.execute("GMAIL_LIST_MESSAGES", {
//     connectedAccountId,
//     arguments: { maxResults: 5 },
//   });

const gmailEndpoints = endpoints.gmail.endpoints;
const calendarEndpoints = endpoints.googlecalendar.endpoints;
const allEndpoints = [...gmailEndpoints, ...calendarEndpoints];

console.log(`\n=== Endpoint Summary ===\n`);
console.log(`Gmail endpoints: ${gmailEndpoints.length}`);
console.log(`Google Calendar endpoints: ${calendarEndpoints.length}`);
console.log(`Total: ${gmailEndpoints.length + calendarEndpoints.length}\n`);

console.log("--- Gmail ---");
for (const ep of gmailEndpoints) {
  console.log(`  ${ep.method.padEnd(6)} ${ep.path.padEnd(55)} ${ep.tool_slug}`);
}

console.log("\n--- Google Calendar ---");
for (const ep of calendarEndpoints) {
  console.log(`  ${ep.method.padEnd(6)} ${ep.path.padEnd(55)} ${ep.tool_slug}`);
}

console.log(`\nRequired scopes (union):`);
const allScopes = new Set([
  ...gmailEndpoints.flatMap((e) => e.required_scopes),
  ...calendarEndpoints.flatMap((e) => e.required_scopes),
]);
for (const scope of allScopes) {
  console.log(`  ${scope}`);
}

const gmailConnectedId = process.env.GMAIL_CONNECTED_ACCOUNT_ID;
const calendarConnectedId = process.env.GOOGLECALENDAR_CONNECTED_ACCOUNT_ID;

if (!gmailConnectedId || !calendarConnectedId) {
  throw new Error(
    "Connected account IDs not set. Add GMAIL_CONNECTED_ACCOUNT_ID and GOOGLECALENDAR_CONNECTED_ACCOUNT_ID to .env"
  );
}

const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY!,
});

const envConnectedAccounts = {
  gmail: gmailConnectedId,
  googlecalendar: calendarConnectedId,
};

await runAgent({
  composio,
  connectedAccounts: envConnectedAccounts,
  endpoints: allEndpoints,
});
