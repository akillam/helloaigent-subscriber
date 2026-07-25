// Subscriber policy (doc 17): the standing "my agent may…" consent layer.
// Everything automatic by default; the human edits this file (or asks their
// agent to) for control. Defaults are written to disk on first run so the
// policy is always visible and editable — never implicit.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { hostname, userInfo } from 'node:os';
import { statePath } from './state.js';

export interface Policy {
  version: 1;
  /** Stable identity across all subscriptions (the email model). Set once; edit to your email. */
  principal: string;
  /** Subscribe when the agent visits a Hello Aigent-enabled site: on (silent), ask (confirm first), off. */
  auto_subscribe: 'on' | 'ask' | 'off';
  /** Default watch cadence: 'hourly' | 'daily' | 'weekly' or a duration like '6h'. Floor is hourly. */
  watch_cadence: string;
  /** What the agent may do with updates unprompted: none | safe (side-effect-free only) | thresholds. */
  act: 'none' | 'safe' | 'thresholds';
  /** Opt-in dial: use a per-site pseudonymous principal instead of the stable one. Off by default. */
  pseudonymous: boolean;
  created_at: string;
}

export function policyPath(): string {
  return process.env.HELLO_AIGENT_POLICY ?? join(dirname(statePath()), 'policy.json');
}

function defaults(): Policy {
  return {
    version: 1,
    // Stable per-machine identity until the human sets a real one (e.g. an email).
    principal: `${userInfo().username}@${hostname()}`,
    auto_subscribe: 'on',
    watch_cadence: 'daily',
    act: 'safe',
    pseudonymous: false,
    created_at: new Date().toISOString(),
  };
}

/** Load the policy, writing defaults to disk on first run. Unknown fields are preserved. */
export async function loadPolicy(): Promise<Policy> {
  const path = policyPath();
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<Policy>;
    return { ...defaults(), ...raw, created_at: raw.created_at ?? new Date().toISOString() };
  } catch {
    const policy = defaults();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 });
    return policy;
  }
}

export async function savePolicy(policy: Policy): Promise<void> {
  const path = policyPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 });
}

/** Parse a cadence ('hourly' | 'daily' | 'weekly' | '6h' | '30m' | …) to milliseconds, floored at hourly. */
export function cadenceMs(cadence: string): number {
  const HOUR = 3_600_000;
  const named: Record<string, number> = {
    hourly: HOUR,
    daily: 24 * HOUR,
    weekly: 7 * 24 * HOUR,
  };
  let ms = named[cadence];
  if (ms === undefined) {
    const m = /^(\d+)(m|h|d)$/.exec(cadence.trim());
    if (!m)
      throw new Error(`unparseable cadence: "${cadence}" (use hourly|daily|weekly or e.g. 6h)`);
    ms = Number(m[1]) * { m: 60_000, h: HOUR, d: 24 * HOUR }[m[2] as 'm' | 'h' | 'd'];
  }
  // Quota-respecting floor (prod: 60s min poll interval, 30 fetches/hr per token).
  return Math.max(ms, HOUR);
}

// Usage-based decay v1 (doc 17): feeds nobody reads stop being polled, then get
// pruned. The signal is "anything surfaced to or asked for by the human/agent"
// — a digest read or an explicit fetch. Thresholds recorded in doc 17's log.
export const DECAY_SKIP_DAYS = 30; // nothing surfaced in 30d → stop polling
export const DECAY_PRUNE_DAYS = 60; // nothing surfaced in 60d → unsubscribe (noted in digest)

export function decayStatus(
  sub: { subscribed_at: string; last_surfaced_at?: string },
  now = Date.now(),
): 'active' | 'decayed' | 'prunable' {
  const ref = new Date(sub.last_surfaced_at ?? sub.subscribed_at).getTime();
  const days = (now - ref) / 86_400_000;
  if (days > DECAY_PRUNE_DAYS) return 'prunable';
  if (days > DECAY_SKIP_DAYS) return 'decayed';
  return 'active';
}
