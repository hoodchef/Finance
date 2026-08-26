import { beforeEach, describe, expect, it } from 'vitest';
import { QueueFullError, __resetQueue, enqueue, getJob, queueStats } from '../src/lib/jobs/queue';

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
