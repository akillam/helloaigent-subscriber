# @helloaigent-dev/subscriber

The **Hello Aigent reference subscriber** — an MCP server that lets any agent subscribe to any
[Hello Aigent](https://helloaigent.dev) feed, fetch signed updates, verify them, and act on them.

```bash
npx @helloaigent-dev/subscriber
```

## Tools

| Tool | What it does |
|---|---|
| `hello_aigent_subscribe(discovery_url, feed_id?, principal, consent_scope)` | Reads the site's `/.well-known/hello-aigent.json`, subscribes on behalf of your principal |
| `hello_aigent_fetch(subscription_id?, max?)` | Pulls only-new-since updates via the stored cursor; **verifies every envelope signature** |
| `hello_aigent_unsubscribe(subscription_id)` | Revokes consent (idempotent) |
| `hello_aigent_list_subscriptions()` | Lists stored subscriptions (tokens are never exposed) |

## Guarantees

- **Signature verification before anything is actionable.** Envelopes are Ed25519-verified
  (RFC 8785 JCS canonicalization) against the feed's discovery public key. Anything that fails
  verification is returned under `unverified` with its `actions` stripped.
- **Consent is surfaced.** Subscribing records the `principal` and `consent_scope`; the tool
  description instructs agents to confirm with their principal first.
- **Local state only.** Subscriptions (including bearer tokens) live in
  `~/.hello-aigent/subscriptions.json` (mode 0600). Override with `HELLO_AIGENT_STATE`.

## MCP client config

```json
{
  "mcpServers": {
    "hello-aigent": { "command": "npx", "args": ["@helloaigent-dev/subscriber"] }
  }
}
```

## License

MIT
