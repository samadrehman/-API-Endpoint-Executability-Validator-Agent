## Required setup 

### 1. Composio account + API key

You'll use [Composio](https://composio.dev) to call API endpoints with managed OAuth auth.

1. Go to [platform.composio.dev](https://platform.composio.dev) and create a free account
2. Navigate to **Settings → API Keys** and generate an API key
3. Save it somewhere — you'll need it during setup

### 2. Connect your Google account

Your agent will test Gmail and Google Calendar endpoints using your own Google account. During setup, you'll be asked to connect your Gmail and Google Calendar via OAuth. To minimize issues:

- Use a **personal   Google account** (not a workspace/org account — these sometimes have restricted OAuth)
- **Strongly recommended: use a throwaway or secondary account** — your agent will take real actions: sending emails, trashing messages, creating/deleting calendar events, etc.
- Make sure the account has some emails and calendar events (the agent needs real data to test against)



### 5. Bun runtime

The project uses [Bun](https://bun.sh) (not Node.js).

```bash
# Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash
```

Verify it works: `bun --version`

---


- **Test early and often** with `bun src/run.ts` — it validates your output format.
- **Start with simple endpoints** (no path params, no body) to get your agent working, then handle the harder cases.

---

*Once you've completed the setup above, click "Start Assignment" to begin your 90 minutes.*
