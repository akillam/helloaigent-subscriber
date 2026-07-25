// Local subscriber state: a user-scoped JSON file holding one
// record per subscription. Override the location with HELLO_AIGENT_STATE
// (used by tests; also handy for multiple profiles).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface StoredSubscription {
  subscription_id: string;
  token: string;
  fetch_url: string;
  unsubscribe_url: string;
  cursor: string;
  feed_id: string;
  feed_title: string;
  discovery_url: string;
  signing_public_key: string;
  principal: string;
  consent_scope: string;
  /** How this subscription came to exist: 'explicit' opt-in or 'auto' (policy on a visit). */
  origin?: 'explicit' | 'auto';
  subscribed_at: string;
  revoked_at?: string;
  /** Usage-based decay (doc 17): last time this feed's updates were surfaced or explicitly fetched. */
  last_surfaced_at?: string;
  /** How many times the human/agent explicitly asked about this feed (bookkeeping for decay). */
  ask_count?: number;
}

interface StateFile {
  subscriptions: StoredSubscription[];
}

export function statePath(): string {
  return process.env.HELLO_AIGENT_STATE ?? join(homedir(), '.hello-aigent', 'subscriptions.json');
}

export async function loadState(): Promise<StateFile> {
  try {
    return JSON.parse(await readFile(statePath(), 'utf8')) as StateFile;
  } catch {
    return { subscriptions: [] };
  }
}

export async function saveState(state: StateFile): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export async function upsertSubscription(sub: StoredSubscription): Promise<void> {
  const state = await loadState();
  const i = state.subscriptions.findIndex((s) => s.subscription_id === sub.subscription_id);
  if (i >= 0) state.subscriptions[i] = sub;
  else state.subscriptions.push(sub);
  await saveState(state);
}

// --- digest/inbox (doc 17 watch): verified updates land here between agent runs ---

export interface DigestEntry {
  id: string;
  kind: 'update' | 'system';
  subscription_id: string;
  feed_id: string;
  feed_title: string;
  received_at: string;
  /** null = unread; set when hello_aigent_digest surfaces it (the decay signal). */
  surfaced_at: string | null;
  /** The verified envelope (kind 'update'). */
  update?: Record<string, unknown>;
  /** Watch bookkeeping lines, e.g. a decay prune (kind 'system'). */
  note?: string;
}

interface DigestFile {
  entries: DigestEntry[];
}

export function digestPath(): string {
  return process.env.HELLO_AIGENT_DIGEST ?? join(dirname(statePath()), 'digest.json');
}

export async function loadDigest(): Promise<DigestFile> {
  try {
    return JSON.parse(await readFile(digestPath(), 'utf8')) as DigestFile;
  } catch {
    return { entries: [] };
  }
}

export async function saveDigest(digest: DigestFile): Promise<void> {
  const path = digestPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(digest, null, 2) + '\n', { mode: 0o600 });
}

export async function appendDigestEntries(entries: DigestEntry[]): Promise<void> {
  if (!entries.length) return;
  const digest = await loadDigest();
  digest.entries.push(...entries);
  await saveDigest(digest);
}
