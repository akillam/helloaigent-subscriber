// Watch mode (doc 17): `npx @helloaigent-dev/subscriber watch [--every 6h] [--once] [--exec "<cmd>"]`
// Polls all non-decayed subscriptions, verifies signatures, and appends verified
// updates to the digest file in the state dir. The server-side mailbox means a
// missed run loses nothing — any cadence is reliable in effect. Schedulers call
// `watch --once`; `--exec` triggers a headless agent run when new updates land.
import { spawn } from 'node:child_process';
import { appendDigestEntries, digestPath, type DigestEntry } from './state.js';
import { activeSubscriptions, fetchUpdates, unsubscribe } from './core.js';
import { cadenceMs, decayStatus, DECAY_PRUNE_DAYS, loadPolicy } from './policy.js';

export interface PassSummary {
  polled: number;
  skipped_decayed: number;
  pruned: number;
  new_updates: number;
  errors: string[];
}

/** One watch pass over all active subscriptions. */
export async function watchPass(): Promise<PassSummary> {
  const summary: PassSummary = {
    polled: 0,
    skipped_decayed: 0,
    pruned: 0,
    new_updates: 0,
    errors: [],
  };
  const now = new Date().toISOString();
  const entries: DigestEntry[] = [];

  for (const sub of await activeSubscriptions()) {
    const status = decayStatus(sub);
    if (status === 'decayed') {
      summary.skipped_decayed++;
      continue;
    }
    if (status === 'prunable') {
      const res = await unsubscribe(sub);
      if (res.ok) {
        summary.pruned++;
        entries.push({
          id: `prune-${sub.subscription_id}`,
          kind: 'system',
          subscription_id: sub.subscription_id,
          feed_id: sub.feed_id,
          feed_title: sub.feed_title,
          received_at: now,
          surfaced_at: null,
          note: `Unsubscribed from "${sub.feed_title}" (${sub.feed_id}): nothing surfaced in ${DECAY_PRUNE_DAYS} days. Resubscribe any time with hello_aigent_subscribe.`,
        });
      } else {
        summary.errors.push(`${sub.feed_id}: ${res.message}`);
      }
      continue;
    }
    summary.polled++;
    const res = await fetchUpdates(sub, 50);
    if (!res.ok) {
      summary.errors.push(`${sub.feed_id}: ${res.message}`);
      continue;
    }
    for (const update of res.result.verified) {
      summary.new_updates++;
      entries.push({
        id: (update.id as string) ?? `${sub.feed_id}-${res.result.next_cursor}`,
        kind: 'update',
        subscription_id: sub.subscription_id,
        feed_id: sub.feed_id,
        feed_title: sub.feed_title,
        received_at: now,
        surfaced_at: null,
        update,
      });
    }
    if (res.result.unverified.length) {
      summary.errors.push(
        `${sub.feed_id}: ${res.result.unverified.length} envelope(s) failed signature verification (dropped)`,
      );
    }
  }

  await appendDigestEntries(entries);
  return summary;
}

function runExec(cmd: string, summary: PassSummary): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: 'inherit',
      env: {
        ...process.env,
        HELLO_AIGENT_NEW_UPDATES: String(summary.new_updates),
        HELLO_AIGENT_DIGEST: digestPath(),
      },
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
}

export interface WatchArgs {
  once: boolean;
  every?: string;
  exec?: string;
}

export function parseWatchArgs(argv: string[]): WatchArgs {
  const args: WatchArgs = { once: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--once') args.once = true;
    else if (argv[i] === '--every') args.every = argv[++i];
    else if (argv[i] === '--exec') args.exec = argv[++i];
    else throw new Error(`unknown watch argument: ${argv[i]}`);
  }
  return args;
}

export async function runWatch(args: WatchArgs): Promise<void> {
  const policy = await loadPolicy();
  const intervalMs = cadenceMs(args.every ?? policy.watch_cadence);

  const pass = async () => {
    const summary = await watchPass();
    const line = `[hello-aigent watch] polled=${summary.polled} new=${summary.new_updates} skipped_decayed=${summary.skipped_decayed} pruned=${summary.pruned}`;
    console.error(summary.errors.length ? `${line} errors=${summary.errors.join('; ')}` : line);
    if (args.exec && summary.new_updates > 0) await runExec(args.exec, summary);
    return summary;
  };

  await pass();
  if (args.once) return;
  console.error(
    `[hello-aigent watch] watching every ${Math.round(intervalMs / 60_000)}m (digest: ${digestPath()})`,
  );
  // Simple interval loop; the mailbox makes catch-up automatic if a pass is missed.
  await new Promise<void>(() => {
    setInterval(() => void pass(), intervalMs);
  });
}
