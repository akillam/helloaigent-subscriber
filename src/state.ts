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
  subscribed_at: string;
  revoked_at?: string;
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
