// Shared subscribe/fetch plumbing used by both the MCP tools (index.ts) and
// watch mode (watch.ts). Every fetched envelope is signature-verified here;
// unverified envelopes have their actions stripped so they are never actionable.
import { verifyEnvelope } from './verify.js';
import { loadState, upsertSubscription, type StoredSubscription } from './state.js';

export async function api(url: string, body: unknown, token?: string) {
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

export interface DiscoveryFeed {
  id: string;
  title: string;
  description?: string;
  topics?: string[];
  signing_public_key: string;
  endpoints: { subscribe: string; fetch: string; unsubscribe: string };
}

export interface Discovery {
  feeds?: DiscoveryFeed[];
}

export async function fetchDiscovery(
  discovery_url: string,
): Promise<{ ok: true; discovery: Discovery } | { ok: false; message: string }> {
  let res: Response;
  try {
    res = await fetch(discovery_url);
  } catch (err) {
    return { ok: false, message: `discovery fetch failed: ${String(err)}` };
  }
  if (!res.ok) return { ok: false, message: `discovery fetch failed: HTTP ${res.status}` };
  const discovery = (await res.json().catch(() => null)) as Discovery | null;
  if (!discovery) return { ok: false, message: 'discovery file is not valid JSON' };
  return { ok: true, discovery };
}

export async function subscribeToFeed(
  feed: DiscoveryFeed,
  discovery_url: string,
  opts: { principal: string; consent_scope: string; origin: 'explicit' | 'auto' },
): Promise<{ ok: true; sub: StoredSubscription } | { ok: false; message: string }> {
  if (!feed.signing_public_key || !feed.endpoints?.subscribe) {
    return { ok: false, message: 'discovery feed is missing signing_public_key or endpoints' };
  }
  const { status, json } = await api(feed.endpoints.subscribe, {
    feed: feed.id,
    principal: opts.principal,
    consent_scope: opts.consent_scope,
    agent_label: 'hello-aigent-reference-subscriber',
    origin: opts.origin,
  });
  if (status !== 201 || !json) {
    return { ok: false, message: `subscribe failed: HTTP ${status} ${JSON.stringify(json)}` };
  }
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
    principal: opts.principal,
    consent_scope: opts.consent_scope,
    origin: opts.origin,
    subscribed_at: new Date().toISOString(),
  };
  await upsertSubscription(sub);
  return { ok: true, sub };
}

export interface FetchResult {
  verified: Array<Record<string, unknown>>;
  unverified: Array<Record<string, unknown>>;
  next_cursor: string;
}

/** Fetch new updates for a subscription, verify signatures, advance the cursor. */
export async function fetchUpdates(
  sub: StoredSubscription,
  max?: number,
): Promise<{ ok: true; result: FetchResult } | { ok: false; message: string }> {
  const { status, json } = await api(
    sub.fetch_url,
    { subscription_id: sub.subscription_id, since_cursor: sub.cursor, ...(max ? { max } : {}) },
    sub.token,
  );
  if (status !== 200 || !json) {
    return { ok: false, message: `fetch failed: HTTP ${status} ${JSON.stringify(json)}` };
  }
  const updates = (json.updates as Array<Record<string, unknown>>) ?? [];
  const verified: Array<Record<string, unknown>> = [];
  const unverified: Array<Record<string, unknown>> = [];
  for (const envelope of updates) {
    if (await verifyEnvelope(envelope, sub.signing_public_key)) verified.push(envelope);
    else unverified.push({ ...envelope, actions: [], signature_verified: false });
  }
  sub.cursor = json.next_cursor as string;
  await upsertSubscription(sub);
  return { ok: true, result: { verified, unverified, next_cursor: sub.cursor } };
}

/** Active (non-revoked) subscriptions. */
export async function activeSubscriptions(): Promise<StoredSubscription[]> {
  const state = await loadState();
  return state.subscriptions.filter((s) => !s.revoked_at);
}

/** Unsubscribe a stored subscription (idempotent server-side). */
export async function unsubscribe(
  sub: StoredSubscription,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { status, json } = await api(
    sub.unsubscribe_url,
    { subscription_id: sub.subscription_id },
    sub.token,
  );
  if (status !== 200) {
    return { ok: false, message: `unsubscribe failed: HTTP ${status} ${JSON.stringify(json)}` };
  }
  sub.revoked_at = new Date().toISOString();
  await upsertSubscription(sub);
  return { ok: true };
}
