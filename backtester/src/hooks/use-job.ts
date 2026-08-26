'use client';

import * as React from 'react';
import type { Job } from '@/lib/jobs/queue';

export interface JobState<T> {
  status: 'idle' | 'queued' | 'running' | 'done' | 'failed';
  result: T | null;
  error: string | null;
  /** Position in the queue while waiting, else null. */
  queuePosition: number | null;
  /** Seconds since the work started, for a progress affordance. */
  elapsedSeconds: number;
}

const IDLE: JobState<never> = {
  status: 'idle',
  result: null,
  error: null,
  queuePosition: null,
  elapsedSeconds: 0,
};

/**
 * Starts queued work and polls it to completion.
 *
 * Polling rather than a socket: the work takes seconds, not minutes, and a
 * socket would be infrastructure for no gain. The interval backs off so a slow
 * job does not generate hundreds of requests while it runs.
 *
 * Every path clears its own timer and aborts its own request. A poll that
 * outlives its component keeps a dead job alive in memory and can overwrite
 * fresher state with staler.
 */
export function useJob<T>() {
  const [state, setState] = React.useState<JobState<T>>(IDLE as JobState<T>);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const controller = React.useRef<AbortController | null>(null);
  const cancelled = React.useRef(false);

  const stop = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    controller.current?.abort();
    controller.current = null;
  }, []);

  React.useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
      stop();
    };
  }, [stop]);

  const poll = React.useCallback(
    (id: string, startedAt: number, attempt: number) => {
      const delay = Math.min(2000, 300 + attempt * 150);
      timer.current = setTimeout(async () => {
        if (cancelled.current) return;
        try {
          const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
          if (cancelled.current) return;

          if (res.status === 404) {
            // Reclaimed after retention, or never existed. Either way the
            // honest instruction is "run it again", not "something broke".
            setState({
              status: 'failed',
              result: null,
              error: 'That result is no longer available. Run it again.',
              queuePosition: null,
              elapsedSeconds: 0,
            });
            return;
          }

          const { job } = (await res.json()) as { job: Job<T> };
          const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);

          if (job.status === 'done') {
            setState({
              status: 'done',
              result: job.result,
              error: null,
              queuePosition: null,
              elapsedSeconds,
            });
            return;
          }
          if (job.status === 'failed') {
            setState({
              status: 'failed',
              result: null,
              error: job.error ?? 'The computation failed.',
              queuePosition: null,
              elapsedSeconds,
            });
            return;
          }

          setState({
            status: job.status,
            result: null,
            error: null,
            queuePosition: job.queuePosition,
            elapsedSeconds,
          });
          poll(id, startedAt, attempt + 1);
        } catch {
          if (!cancelled.current) {
            setState({
              status: 'failed',
              result: null,
              error: 'Lost contact with the server while waiting for the result.',
              queuePosition: null,
              elapsedSeconds: 0,
            });
          }
        }
      }, delay);
    },
    [],
  );

  const start = React.useCallback(
    async (url: string, body: unknown) => {
      stop();
      const ac = new AbortController();
      controller.current = ac;
      const startedAt = Date.now();
      setState({
        status: 'queued',
        result: null,
        error: null,
        queuePosition: null,
        elapsedSeconds: 0,
      });

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not start the computation.');
        poll((json.job as Job<T>).id, startedAt, 0);
      } catch (e) {
        if (ac.signal.aborted || cancelled.current) return;
        setState({
          status: 'failed',
          result: null,
          error: e instanceof Error ? e.message : 'Could not start the computation.',
          queuePosition: null,
          elapsedSeconds: 0,
        });
      }
    },
    [poll, stop],
  );

  const reset = React.useCallback(() => {
    stop();
    setState(IDLE as JobState<T>);
  }, [stop]);

  return { ...state, start, reset };
}
