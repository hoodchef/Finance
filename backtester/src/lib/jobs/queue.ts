import fs from 'node:fs';
import path from 'node:path';

/**
 * Job queue for long computations, durable across restarts.
 * =============================================================================
 * A backtest against two providers takes ~20 seconds cold. Held open as a
 * synchronous request that is a connection blocked for 20 seconds, a client
 * with no way to show progress, and a result thrown away entirely if the
 * browser navigates. One user tolerates it; a second one does not.
 *
 * This accepts the work, returns an id immediately, and runs it with a
 * concurrency limit. The client polls.
 *
 * Finished jobs are mirrored to disk, so a dev-server restart — or a crash
 * mid-analysis — no longer throws away a result that took twenty seconds to
 * compute. The store is a plain JSON file under the cache directory, which
 * keeps the zero-setup promise: no Redis, no database, nothing to run.
 *
 * WHAT THIS STILL IS NOT: shared. A second server instance has its own file
 * and its own memory, so this does not distribute work. That genuinely needs
 * Redis or a database table plus a worker, and should not be added until
 * something is actually deployed. The interface below is the part that would
 * survive that move; only the persistence swaps out.
 *
 * A job that was RUNNING when the process died is resurrected as failed, not
 * as running. Anything else leaves a job that no worker owns, polling forever
 * against a promise nobody is keeping.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job<T = unknown> {
  id: string;
  kind: string;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** Set only when status is 'done'. */
  result: T | null;
  /** A message safe to show a user; internals are logged, not returned. */
  error: string | null;
  /** Position in the queue while waiting, else null. */
  queuePosition: number | null;
}

interface Entry<T> extends Job<T> {
  run: () => Promise<T>;
}

/** Concurrency cap. Each job holds provider connections and CPU. */
const MAX_CONCURRENT = 2;
/** Finished jobs are readable for this long, then reclaimed. */
const RETENTION_MS = 10 * 60 * 1000;
/** Refuses new work beyond this, rather than queueing without bound. */
const MAX_PENDING = 64;

const jobs = new Map<string, Entry<unknown>>();
const waiting: string[] = [];
let active = 0;

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

function storePath(): string {
  const dir = process.env.MARKET_DATA_CACHE_DIR ?? '.cache/market-data';
  const base = path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
  return path.join(base, 'jobs.json');
}

/** Only settled jobs are worth persisting; the rest cannot survive anyway. */
function persist(): void {
  try {
    const settled = [...jobs.values()]
      .filter((j) => j.status === 'done' || j.status === 'failed')
      .map(({ run: _run, ...rest }) => rest);
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Written via a temp file and renamed: a half-written store read back on
    // the next boot would throw away every result, not just the newest.
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settled));
    fs.renameSync(tmp, file);
  } catch {
    // Persistence failing must never fail the job that triggered it.
  }
}

let restored = false;

/** Reads the store once per process, dropping anything already expired. */
function restore(): void {
  if (restored) return;
  restored = true;
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Array<Job<unknown>>;
    const cutoff = Date.now() - RETENTION_MS;
    for (const job of parsed) {
      if (!job?.id || typeof job.id !== 'string') continue;
      if (job.finishedAt !== null && job.finishedAt < cutoff) continue;
      jobs.set(job.id, {
        ...job,
        // A job cannot be resumed — the closure that would run it did not
        // survive the restart — so it must never claim it is still working.
        status: job.status === 'done' ? 'done' : 'failed',
        error: job.status === 'done' ? null : (job.error ?? 'Interrupted by a restart.'),
        queuePosition: null,
        run: async () => {
          throw new Error('restored');
        },
      } as Entry<unknown>);
    }
  } catch {
    // No store, or an unreadable one. Starting empty is correct.
  }
}

export class QueueFullError extends Error {}

function sweep(): void {
  const cutoff = Date.now() - RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.finishedAt !== null && job.finishedAt < cutoff) jobs.delete(id);
  }
}

function publicView<T>(entry: Entry<T>): Job<T> {
  const idx = waiting.indexOf(entry.id);
  return {
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    createdAt: entry.createdAt,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    result: entry.result,
    error: entry.error,
    queuePosition: idx >= 0 ? idx + 1 : null,
  };
}

function pump(): void {
  while (active < MAX_CONCURRENT && waiting.length > 0) {
    const id = waiting.shift()!;
    const entry = jobs.get(id);
    if (!entry || entry.status !== 'queued') continue;

    active++;
    entry.status = 'running';
    entry.startedAt = Date.now();

    entry
      .run()
      .then((value) => {
        entry.result = value;
        entry.status = 'done';
      })
      .catch((err) => {
        // Same discipline as the HTTP error path: the message a user sees is
        // one we wrote, never whatever a driver happened to throw.
        console.error(`[job:${entry.kind}]`, err);
        entry.error =
          err && typeof err === 'object' && 'userMessage' in err
            ? String((err as { userMessage: unknown }).userMessage)
            : 'The computation failed.';
        entry.status = 'failed';
      })
      .finally(() => {
        entry.finishedAt = Date.now();
        active--;
        persist();
        sweep();
        pump();
      });
  }
}

/** Queues work and returns immediately. */
export function enqueue<T>(kind: string, run: () => Promise<T>): Job<T> {
  restore();
  sweep();
  const pending = [...jobs.values()].filter(
    (j) => j.status === 'queued' || j.status === 'running',
  ).length;
  if (pending >= MAX_PENDING) {
    throw new QueueFullError('The server is busy. Try again shortly.');
  }

  const id = `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const entry: Entry<T> = {
    id,
    kind,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    queuePosition: null,
    run,
  };
  jobs.set(id, entry as Entry<unknown>);
  waiting.push(id);
  pump();
  return publicView(entry);
}

export function getJob<T = unknown>(id: string): Job<T> | undefined {
  restore();
  const entry = jobs.get(id) as Entry<T> | undefined;
  return entry ? publicView(entry) : undefined;
}

/** Queue depth and load, for the Lab and for operational visibility. */
export function queueStats(): {
  active: number;
  queued: number;
  retained: number;
  maxConcurrent: number;
} {
  restore();
  return {
    active,
    queued: waiting.length,
    retained: jobs.size,
    maxConcurrent: MAX_CONCURRENT,
  };
}

/** Test seam: drops every job and resets counters. */
export function __resetQueue(): void {
  jobs.clear();
  waiting.length = 0;
  active = 0;
  restored = true; // Tests supply their own state rather than reading the store.
}

/** Test seam: forces the next call to read the store from disk again. */
export function __reloadQueue(): void {
  jobs.clear();
  waiting.length = 0;
  active = 0;
  restored = false;
}
