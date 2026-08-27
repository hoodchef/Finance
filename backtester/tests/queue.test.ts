import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  QueueFullError,
  __reloadQueue,
  __resetQueue,
  enqueue,
  getJob,
  queueStats,
} from '../src/lib/jobs/queue';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
/** Waits for a job to leave the running state, or gives up. */
async function settle(id: string, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const j = getJob(id);
    if (!j || j.status === 'done' || j.status === 'failed') return;
    if (Date.now() > until) throw new Error(`job ${id} did not settle`);
    await tick();
  }
}

describe('the job queue', () => {
  beforeEach(() => __resetQueue());

  it('returns an id before the work is done', async () => {
    const job = enqueue('test', async () => {
      await tick(50);
      return 42;
    });
    // The whole point: the caller is not blocked.
    expect(job.status).toBe('running');
    expect(job.result).toBeNull();
    await settle(job.id);
    expect(getJob<number>(job.id)!.result).toBe(42);
  });

  it('reports completion and timing', async () => {
    const job = enqueue('test', async () => 'value');
    await settle(job.id);
    const done = getJob<string>(job.id)!;
    expect(done.status).toBe('done');
    expect(done.result).toBe('value');
    expect(done.startedAt).not.toBeNull();
    expect(done.finishedAt).not.toBeNull();
    expect(done.finishedAt!).toBeGreaterThanOrEqual(done.startedAt!);
  });

  it('caps concurrency and queues the rest', async () => {
    let peak = 0;
    let running = 0;
    const ids = Array.from({ length: 6 }, () =>
      enqueue('test', async () => {
        running++;
        peak = Math.max(peak, running);
        await tick(30);
        running--;
        return 1;
      }).id,
    );
    // Two run, four wait — and the waiting ones know where they are.
    const queued = ids.map((id) => getJob(id)!).filter((j) => j.status === 'queued');
    expect(queued.length).toBe(4);
    expect(queued[0].queuePosition).toBe(1);

    await Promise.all(ids.map((id) => settle(id)));
    expect(peak).toBeLessThanOrEqual(queueStats().maxConcurrent);
    expect(ids.every((id) => getJob(id)!.status === 'done')).toBe(true);
  });

  it('records a failure without exposing the underlying error', async () => {
    const job = enqueue('test', async () => {
      throw new Error('connect ECONNREFUSED /Users/me/.env.local token=abc123secret');
    });
    await settle(job.id);
    const failed = getJob(job.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.error).not.toMatch(/token|secret|abc123|Users/);
    expect(failed.error).toBe('The computation failed.');
  });

  it('keeps draining after a job throws', async () => {
    const bad = enqueue('test', async () => {
      throw new Error('boom');
    });
    const good = enqueue('test', async () => 'fine');
    await settle(bad.id);
    await settle(good.id);
    // A failure that stalled the pump would leave the queue wedged forever.
    expect(getJob(bad.id)!.status).toBe('failed');
    expect(getJob<string>(good.id)!.result).toBe('fine');
    expect(queueStats().active).toBe(0);
  });

  it('refuses new work rather than queueing without bound', async () => {
    const release: Array<() => void> = [];
    for (let i = 0; i < 64; i++) {
      enqueue('test', () => new Promise<number>((res) => release.push(() => res(1))));
    }
    expect(() => enqueue('test', async () => 1)).toThrow(QueueFullError);
    release.forEach((fn) => fn());
  });

  it('returns undefined for an id it does not know', () => {
    expect(getJob('nope')).toBeUndefined();
  });
});

describe('surviving a restart', () => {
  const store = path.join(process.cwd(), '.cache', 'market-data', 'jobs.json');

  beforeEach(() => {
    try {
      fs.unlinkSync(store);
    } catch {
      /* absent is fine */
    }
    __resetQueue();
  });

  it('serves a completed result after the process is gone', async () => {
    const job = enqueue('test', async () => ({ answer: 42 }));
    await settle(job.id);

    // Simulate a restart: the map and every closure in it are gone.
    __reloadQueue();

    const after = getJob<{ answer: number }>(job.id);
    expect(after?.status).toBe('done');
    // A twenty-second computation should not be thrown away by a dev-server
    // reload, which is the whole point.
    expect(after?.result).toEqual({ answer: 42 });
  });

  it('does not resurrect a job as still running', async () => {
    // A job with no worker behind it would be polled forever against a promise
    // nobody is keeping.
    const job = enqueue('test', async () => 'value');
    await settle(job.id);
    fs.writeFileSync(
      store,
      JSON.stringify([
        {
          id: 'ghost',
          kind: 'test',
          status: 'running',
          createdAt: Date.now(),
          startedAt: Date.now(),
          finishedAt: null,
          result: null,
          error: null,
          queuePosition: null,
        },
      ]),
    );
    __reloadQueue();

    const ghost = getJob('ghost');
    expect(ghost?.status).toBe('failed');
    expect(ghost?.error).toMatch(/restart/i);
  });

  it('drops results older than the retention window', async () => {
    fs.writeFileSync(
      store,
      JSON.stringify([
        {
          id: 'ancient',
          kind: 'test',
          status: 'done',
          createdAt: 0,
          startedAt: 0,
          finishedAt: 1,
          result: 'stale',
          error: null,
          queuePosition: null,
        },
      ]),
    );
    __reloadQueue();
    expect(getJob('ancient')).toBeUndefined();
  });

  it('starts clean when the store is corrupt rather than failing', async () => {
    // A half-written file must cost the results in it, not the queue itself.
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, '{"not":"an array"');
    __reloadQueue();
    const job = enqueue('test', async () => 'fine');
    await settle(job.id);
    expect(getJob<string>(job.id)?.result).toBe('fine');
  });

  it('never persists an unsettled job', async () => {
    const release: Array<() => void> = [];
    const job = enqueue('test', () => new Promise<string>((r) => release.push(() => r('done'))));
    // Nothing on disk yet: it has not finished.
    expect(fs.existsSync(store)).toBe(false);
    release.forEach((fn) => fn());
    await settle(job.id);
    expect(JSON.parse(fs.readFileSync(store, 'utf8'))).toHaveLength(1);
  });
});
