'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { deliveredInputs, SCENARIOS, SCENARIO_INDICES } from '@/lib/valuation/asts/inputs';
import { runModel, snapshotStats } from '@/lib/valuation/asts/engine';
import { runChecks } from '@/lib/valuation/asts/checks';
import { sensitivityGrid } from '@/lib/valuation/asts/analytics';
import { intrinsicModelFor } from '@/lib/valuation/registry';
import { cn } from '@/lib/utils';
import { loadStored } from './storage';
import { SCENARIO_COLOR, diffInputs } from './use-asts-valuation';
import { signedPct, usd } from './format';

/**
 * The desk's one long-horizon reading: where the price sits against the
 * intrinsic model, for the few securities that have one.
 *
 * It shows the reader's own model — edits made on the Valuation page included
 * — so the desk and that page never quote two different values. It runs the
 * four scenarios and the checks (a few milliseconds); the simulation and the
 * sensitivity live on the Valuation page, one click away.
 */
export function IntrinsicValueCard({ symbol, price }: { symbol: string; price: number | null }) {
  const model = intrinsicModelFor(symbol);
  const [inputs, setInputs] = React.useState(deliveredInputs);
  React.useEffect(() => {
    const s = loadStored();
    if (s) setInputs(s.inputs);
  }, []);

  const result = React.useMemo(() => {
    if (!model) return null;
    const m = runModel(inputs);
    const checks = runChecks(inputs, m, snapshotStats(inputs), sensitivityGrid(inputs, m.runs[2]).values[2][2]);
    return { m, checks, edited: diffInputs(deliveredInputs(), inputs).length };
  }, [model, inputs]);

  if (!model || !result) return null;
  const { m, checks, edited } = result;
  const vs = price != null ? m.pw / price - 1 : null;

  return (
    <section aria-label="Intrinsic value" className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-card px-4 py-3 text-xs">
      <div>
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">Intrinsic value · {model.name}</div>
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-semibold">{usd(m.pw)}</span>
          {vs != null && (
            <span className={cn('numeric', vs >= 0 ? 'text-positive' : 'text-negative')}>{signedPct(vs)} vs {usd(price)}</span>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {SCENARIO_INDICES.map((s) => (
          <span key={s} className="numeric flex items-center gap-1.5 text-muted-foreground">
            <span aria-hidden className="size-2 rounded-full" style={{ background: SCENARIO_COLOR[s] }} />
            {SCENARIOS[s]} <span className="text-foreground">{usd(m.runs[s].vps)}</span>
            <span className="text-2xs">({Math.round(m.probs[s] * 100)}%)</span>
          </span>
        ))}
      </div>
      <div className="text-muted-foreground">
        Checks <span className={checks.failed ? 'font-medium text-negative' : 'text-foreground'}>{checks.status}</span>
        {edited > 0 && <span className="text-[hsl(var(--warning))]"> · {edited} input{edited === 1 ? '' : 's'} edited</span>}
      </div>
      <Link href={model.href} className="ml-auto inline-flex items-center gap-1 font-medium text-primary hover:underline">
        Open the model <ArrowRight className="size-3.5" />
      </Link>
    </section>
  );
}
