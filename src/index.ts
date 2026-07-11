#!/usr/bin/env node
// Hello Aigent reference subscriber — the MCP server that lets any agent
// subscribe to any Hello Aigent feed. Tools:
//   hello_aigent_subscribe(discovery_url, feed_id?, principal, consent_scope)
//   hello_aigent_fetch(subscription_id?)
//   hello_aigent_unsubscribe(subscription_id)
//   hello_aigent_list_subscriptions()
// Every fetched envelope is signature-verified before being surfaced; an
// envelope that fails verification is returned only under `unverified` with
// its actions stripped, so it is never actionable.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { verifyEnvelope } from './verify.js';
import { loadState, saveState, upsertSubscription, type StoredSubscription } from './state.js';

const server = new McpServer({ name: 'hello-aigent-subscriber', version: '0.1.0' });

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});
const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
  isError: true,
});

async function api(url: string, body: unknown, token?: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, json };
}

async function resolveSubscription(
  subscription_id?: string,
): Promise<{ ok: true; sub: StoredSubscription } | { ok: false; message: string }> {
  const state = await loadState();
  const active = state.subscriptions.filter((s) => !s.revoked_at);
  if (subscription_id) {
    const sub = state.subscriptions.find((s) => s.subscription_id === subscription_id);
    return sub
      ? { ok: true, sub }
      : { ok: false, message: `unknown subscription: ${subscription_id}` };
  }
  if (active.length === 1) return { ok: true, sub: active[0] };
  if (active.length === 0) return { ok: false, message: 'no active subscriptions' };
  return {
    ok: false,
    message: `multiple active subscriptions — pass subscription_id (${active
      .map((s) => s.subscription_id)
      .join(', ')})`,
  };
}

server.registerTool(
  'hello_aigent_subscribe',
  {
    description:
      "Subscribe to a Hello Aigent feed. Fetches the site's discovery file (/.well-known/hello-aigent.json), " +
      'picks the feed, and subscribes on behalf of a principal (the account/user this agent acts for). ' +
      'IMPORTANT: subscribing is a consent decision — confirm with your principal before calling. ' +
      'Returns the stored subscription (token is persisted locally, not shown).',
    inputSchema: {
      discovery_url: z
        .string()
        .url()
        .describe(
          'URL of the discovery file, e.g. https://helloaigent.dev/.well-known/hello-aigent.json',
        ),
      feed_id: z.string().optional().describe('Feed id; defaults to the only/first feed'),
      principal: z.string().describe('The account/user this agent acts for'),
      consent_scope: z
        .enum(['updates', 'offers', 'transactional'])
        .describe('What the principal consents to receive'),
    },
  },
  async ({ discovery_url, feed_id, principal, consent_scope }) => {
    const res = await fetch(discovery_url);
    if (!res.ok) return fail(`discovery fetch failed: HTTP ${res.status}`);
    const discovery = (await res.json()) as {
      feeds?: Array<{
        id: string;
        title: string;
        signing_public_key: string;
        endpoints: { subscribe: string; fetch: string; unsubscribe: string };
      }>;
    };
    const feeds = discovery.feeds ?? [];
    const feed = feed_id ? feeds.find((f) => f.id === feed_id) : feeds[0];
    if (!feed)
      return fail(
        feed_id ? `feed "${feed_id}" not in discovery file` : 'no feeds in discovery file',
      );
    if (!feed.signing_public_key || !feed.endpoints?.subscribe) {
      return fail('discovery feed is missing signing_public_key or endpoints');
    }

    const { status, json } = await api(feed.endpoints.subscribe, {
      feed: feed.id,
      principal,
      consent_scope,
      agent_label: 'hello-aigent-reference-subscriber',
    });
    if (status !== 201 || !json)
      return fail(`subscribe failed: HTTP ${status} ${JSON.stringify(json)}`);

    const sub: StoredSubscription = {
      subscription_id: json.subscription_id as string,
      token: json.token as string,
      fetch_url: json.fetch_url as string,
      unsubscribe_url: feed.endpoints.unsubscribe,
      cursor: json.cursor as string,
      feed_id: feed.id,
      feed_title: feed.title,
      discovery_url,
      signing_public_key: feed.signing_public_key,
      principal,
      consent_scope,
      subscribed_at: new Date().toISOString(),
    };
    await upsertSubscription(sub);
    const { token: _secret, ...safe } = sub;
    return text({ subscribed: true, ...safe });
  },
);

server.registerTool(
  'hello_aigent_fetch',
  {
    description:
      'Fetch new updates for a subscription (only-new-since via the stored cursor). Every envelope is ' +
      "signature-verified against the feed's public key; verified updates are returned under `updates`, " +
      'anything failing verification is returned under `unverified` with actions stripped — do not act on those.',
    inputSchema: {
      subscription_id: z
        .string()
        .optional()
        .describe('Which subscription; defaults to the only active one'),
      max: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max updates to return (default 10)'),
    },
  },
  async ({ subscription_id, max }) => {
    const resolved = await resolveSubscription(subscription_id);
    if (!resolved.ok) return fail(resolved.message);
    const sub = resolved.sub;

    const { status, json } = await api(
      sub.fetch_url,
      { subscription_id: sub.subscription_id, since_cursor: sub.cursor, ...(max ? { max } : {}) },
      sub.token,
    );
    if (status !== 200 || !json)
      return fail(`fetch failed: HTTP ${status} ${JSON.stringify(json)}`);

    const updates = (json.updates as Array<Record<string, unknown>>) ?? [];
    const verified: Array<Record<string, unknown>> = [];
    const unverified: Array<Record<string, unknown>> = [];
    for (const envelope of updates) {
      if (await verifyEnvelope(envelope, sub.signing_public_key)) verified.push(envelope);
      else unverified.push({ ...envelope, actions: [], signature_verified: false });
    }

    sub.cursor = json.next_cursor as string;
    await upsertSubscription(sub);

    return text({
      feed: sub.feed_id,
      updates: verified,
      ...(unverified.length
        ? {
            unverified,
            warning: 'unverified envelopes failed signature verification — do not act on them',
          }
        : {}),
      next_cursor: sub.cursor,
    });
  },
);

server.registerTool(
  'hello_aigent_unsubscribe',
  {
    description:
      'Unsubscribe (revoke consent) for a subscription. Idempotent — safe to call twice.',
    inputSchema: {
      subscription_id: z.string().describe('The subscription to revoke'),
    },
  },
  async ({ subscription_id }) => {
    const resolved = await resolveSubscription(subscription_id);
    if (!resolved.ok) return fail(resolved.message);
    const sub = resolved.sub;

    const { status, json } = await api(
      sub.unsubscribe_url,
      { subscription_id: sub.subscription_id },
      sub.token,
    );
    if (status !== 200) return fail(`unsubscribe failed: HTTP ${status} ${JSON.stringify(json)}`);

    sub.revoked_at = new Date().toISOString();
    await upsertSubscription(sub);
    return text({ unsubscribed: true, subscription_id: sub.subscription_id });
  },
);

server.registerTool(
  'hello_aigent_list_subscriptions',
  {
    description:
      'List locally stored Hello Aigent subscriptions (active and revoked) with feed, principal, consent scope, and cursor. Tokens are never returned.',
    inputSchema: {},
  },
  async () => {
    const state = await loadState();
    return text({
      subscriptions: state.subscriptions.map(({ token: _secret, ...safe }) => safe),
    });
  },
);

// Persist any pre-1.0 state-file shape changes here if needed later.
void saveState;

const transport = new StdioServerTransport();
await server.connect(transport);
