# @helloaigent-dev/subscriber

The **Hello Aigent reference subscriber** — an MCP server that lets any agent subscribe to any
[Hello Aigent](https://helloaigent.dev) feed, fetch signed updates, verify them, and act on them.
Plus **watch mode**: a standing poller that collects verified updates into a digest between agent runs.

```bash
npx @helloaigent-dev/subscriber            # MCP server (stdio)
npx @helloaigent-dev/subscriber watch      # standing watcher (default cadence: daily)
```

## Tools

| Tool | What it does |
|---|---|
| `hello_aigent_subscribe(discovery_url, feed_id?, principal?, consent_scope?)` | Reads the site's `/.well-known/hello-aigent.json`, subscribes (defaults come from your policy) |
| `hello_aigent_fetch(subscription_id?, max?)` | Pulls only-new-since updates via the stored cursor; **verifies every envelope signature** |
| `hello_aigent_unsubscribe(subscription_id)` | Revokes consent (idempotent) — the one-call undo |
| `hello_aigent_list_subscriptions()` | Lists stored subscriptions (tokens are never exposed) |
| `hello_aigent_check_site(url)` | Checks a site you're visiting for a feed; auto-subscribes per your standing policy (`origin: auto`) |
| `hello_aigent_digest()` | Returns unread digest entries collected by `watch` and marks them surfaced |
| `hello_aigent_setup_watch(cadence?)` | Emits ready-to-apply standing-schedule recipes (scheduled task, recurring task, cron) |

## Watch mode

```bash
npx @helloaigent-dev/subscriber watch --once            # one pass (what schedulers call)
npx @helloaigent-dev/subscriber watch --every 6h        # long-running loop (floor: hourly)
npx @helloaigent-dev/subscriber watch --once --exec "my-agent-cmd"   # trigger a run on new updates
```

Each pass polls every active subscription, verifies signatures, and appends new updates to the
digest file. The server-side mailbox means a missed run loses nothing. `--exec` runs your command
when new updates land, with `HELLO_AIGENT_NEW_UPDATES` and `HELLO_AIGENT_DIGEST` set.

## Policy

Written to `~/.hello-aigent/policy.json` on first run — everything automatic by default, and this
file is where you change that:

| Key | Default | Meaning |
|---|---|---|
| `principal` | `user@host` | Your stable identity across all feeds — set it once (e.g. your email) |
| `auto_subscribe` | `on` | Subscribe when your agent visits a Hello Aigent site: `on` / `ask` / `off` |
| `watch_cadence` | `daily` | How often watch polls (`hourly` floor) |
| `act` | `safe` | What the agent may do unprompted: `none` / `safe` (side-effect-free) / `thresholds` |
| `pseudonymous` | `false` | Opt-in: per-site pseudonymous principals |

Feeds nobody reads decay: after 30 idle days watch stops polling them; after 60 it unsubscribes
(noted in the digest). Reading the digest or fetching a feed keeps it alive.

## Guarantees

- **Signature verification before anything is actionable.** Envelopes are Ed25519-verified
  (RFC 8785 JCS canonicalization) against the feed's discovery public key. Anything that fails
  verification is returned under `unverified` with its `actions` stripped.
- **Consent is standing policy.** Subscribing records `principal` + `consent_scope`; your policy
  file is the consent layer, and unsubscribe is always one idempotent call.
- **Local state only.** Subscriptions (including bearer tokens), policy, and the digest live in
  `~/.hello-aigent/` (mode 0600). Override with `HELLO_AIGENT_STATE` / `HELLO_AIGENT_POLICY` /
  `HELLO_AIGENT_DIGEST`.

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
