'use client';

import * as React from 'react';
import { AlertCircle, Play, RefreshCw, Sigma } from 'lucide-react';
import type { BacktestConfig, Portfolio } from '@/lib/types';
import type { RegressionResult } from '@/lib/analysis/regression';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Stat } from '@/components/ui/stat';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

interface Response {
  model: { id: string; label: string; description: string; withMomentum: boolean };
  regression: RegressionResult;
  window: {
    start: string;
    end: string;
    portfolioStart: string;
    portfolioEnd: string;
    truncated: boolean;
    observations: number;
  };
  factorData: {
    lastAvailable: Array<{ id: string; date: string }>;
    fetchedAt: string;
    attribution: string;
  };
}

/** What each loading means, in the terms a holder of the portfolio would use. */
const MEANING: Record<string, string> = {
  'Mkt-RF': 'Exposure to the market itself. 1.00 moves with it point for point.',
  SMB: 'Small minus big. Positive means tilted toward smaller companies.',
  HML: 'High minus low book-to-market. Positive means tilted toward value.',
  RMW: 'Robust minus weak profitability. Positive means tilted toward quality.',
  CMA: 'Conservative minus aggressive investment. Positive means tilted toward firms that reinvest less.',
  Mom: 'Momentum. Positive means tilted toward recent winners.',
};

/**
 * Fama–French factor regression.
 *
 * The panel is arranged around one question — is there alpha? — because that is
 * the number people come to a factor regression for and the one most often
 * misread. The p-value sits beside the estimate rather than behind a tooltip,
 * and when alpha is statistically indistinguishable from zero the panel says so
 * in words instead of leaving a small number to be read as a large claim.
 */
export function FactorPanel({
  portfolio,
  config,
}: {
  portfolio: Pick<Portfolio, 'id' | 'name' | 'positions'>;
  config: BacktestConfig;
}) {
  const [model, setModel] = React.useState<'ff3' | 'ff5'>('ff3');
  const [momentum, setMomentum] = React.useState(false);
  const [data, setData] = React.useState<Response | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const controller = React.useRef<AbortController | null>(null);

  async function run() {
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/factors', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portfolio, config, model, momentum }),
        signal: ac.signal,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Regression failed.');
      if (!ac.signal.aborted) setData(json as Response);
    } catch (e) {
      if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'Regression failed.');
    } finally {
      if (!ac.signal.aborted) setPending(false);
    }
  }

  React.useEffect(() => () => controller.current?.abort(), []);

  const fit = data?.regression;
  // Three bands, not two. A p just over 0.05 is a different statement from a p
  // of 0.9, and collapsing them lets a borderline result be read as a null one.
  const alphaVerdict: 'significant' | 'borderline' | 'null' = !fit
    ? 'null'
    : fit.alpha.pValue < 0.05
      ? 'significant'
      : fit.alpha.pValue < 0.1
        ? 'borderline'
        : 'null';
  const alphaSignificant = alphaVerdict === 'significant';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Sigma className="h-4 w-4" />
              Factor regression
              <Badge variant="outline">Fama–French</Badge>
            </CardTitle>
            <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
              Splits this portfolio&rsquo;s excess return into known sources of risk. What is left
              over — alpha — is return the factors do not explain.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Select value={model} onValueChange={(v) => setModel(v as 'ff3' | 'ff5')}>
              <SelectTrigger className="h-9 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ff3">3-factor</SelectItem>
                <SelectItem value="ff5">5-factor</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={momentum ? 'yes' : 'no'}
              onValueChange={(v) => setMomentum(v === 'yes')}
            >
              <SelectTrigger className="h-9 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no">Without momentum</SelectItem>
                <SelectItem value="yes">With momentum</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={run} disabled={pending}>
              {pending ? (
                <>
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Running…
                </>
              ) : (
                <>
                  {data ? <RefreshCw /> : <Play />}
                  {data ? 'Rerun' : 'Analyse'}
                </>
              )}
            </Button>
          </div>
        </div>
      </CardHeader>

      {error && (
        <CardContent>
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-3 text-xs">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="leading-relaxed">{error}</p>
          </div>
        </CardContent>
      )}

      {pending && !fit && (
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      )}

      {!fit && !pending && !error && (
        <CardContent>
          <EmptyState
            icon={Sigma}
            title="Not run yet"
            description="Regresses the portfolio's daily excess return on the Fama–French factors, which are fetched from the Kenneth French Data Library."
            className="border-0 py-10"
          />
        </CardContent>
      )}

      {fit && data && (
        <CardContent className={cn('space-y-4', pending && 'opacity-60')}>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
            <Stat
              className="bg-card"
              label="Alpha (annual)"
              tone={alphaSignificant ? (fit.alphaAnnualised > 0 ? 'positive' : 'negative') : 'neutral'}
              value={formatPercent(fit.alphaAnnualised)}
              sub={
                alphaVerdict === 'significant'
                  ? `p = ${fit.alpha.pValue.toFixed(3)}`
                  : alphaVerdict === 'borderline'
                    ? `borderline, p = ${fit.alpha.pValue.toFixed(3)}`
                    : 'not distinguishable from zero'
              }
              hint="Return the factor model does not explain. Only meaningful if the p-value is small — otherwise the estimate is indistinguishable from luck."
            />
            <Stat
              className="bg-card"
              label="t-statistic"
              value={fit.alpha.tStat.toFixed(2)}
              sub={`${fit.neweyWestLags} lags, HAC`}
              hint="Alpha divided by its Newey–West standard error, which corrects for the autocorrelation and changing volatility in daily returns. Roughly ±2 is the conventional threshold."
            />
            <Stat
              className="bg-card"
              label="R²"
              value={formatPercent(fit.rSquared, 1)}
              sub={`adj. ${formatPercent(fit.adjRSquared, 1)}`}
              hint="Share of the portfolio's day-to-day variation the factors account for. High R² means the portfolio is well described by these risks, not that it performed well."
            />
            <Stat
              className="bg-card"
              label="Observations"
              value={fit.observations.toLocaleString()}
              sub={`${data.window.start} – ${data.window.end}`}
            />
          </div>

          {/* The verdict on alpha, stated rather than left to be inferred. */}
          <div
            className={cn(
              'rounded-md border p-3 text-xs leading-relaxed',
              alphaVerdict === 'null'
                ? 'border-border bg-muted/40'
                : 'border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8',
            )}
          >
            {alphaVerdict === 'significant' ? (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  Alpha of {formatPercent(fit.alphaAnnualised)} a year survives the factors
                </span>{' '}
                (t = {fit.alpha.tStat.toFixed(2)}, p = {fit.alpha.pValue.toFixed(4)}). That is a
                statement about this window and this factor set, not a forecast. Adding factors
                usually shrinks it — try the 5-factor model{!data.model.withMomentum && ' and momentum'}{' '}
                before treating it as skill.
              </p>
            ) : alphaVerdict === 'borderline' ? (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  Alpha of {formatPercent(fit.alphaAnnualised)} a year, but only just outside the
                  conventional threshold
                </span>{' '}
                (t = {fit.alpha.tStat.toFixed(2)}, p = {fit.alpha.pValue.toFixed(3)}). A result
                this close to the line is not evidence of skill and not evidence against it; it
                would move either way on a slightly different window. Treat the estimate as
                unresolved rather than as a number.
              </p>
            ) : (
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  No alpha here that can be told apart from noise
                </span>{' '}
                (t = {fit.alpha.tStat.toFixed(2)}, p = {fit.alpha.pValue.toFixed(3)}). The
                estimate of {formatPercent(fit.alphaAnnualised)} a year carries a standard error
                far too wide to separate it from zero — the factors below account for what this
                portfolio did.
              </p>
            )}
          </div>

          {/* Loadings */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Factor</th>
                  <th className="py-2 pr-3 text-right font-medium">Loading</th>
                  <th className="py-2 pr-3 text-right font-medium">Std. error</th>
                  <th className="py-2 pr-3 text-right font-medium">t</th>
                  <th className="py-2 pr-3 text-right font-medium">p</th>
                  <th className="py-2 font-medium">What it means</th>
                </tr>
              </thead>
              <tbody>
                {fit.betas.map((b) => (
                  <tr key={b.name} className="border-b border-border/50 last:border-0">
                    <td className="py-2 pr-3 font-medium">{b.name}</td>
                    <td
                      className={cn(
                        'numeric py-2 pr-3 text-right',
                        b.pValue >= 0.05 && 'text-muted-foreground',
                      )}
                    >
                      {b.estimate.toFixed(3)}
                    </td>
                    <td className="numeric py-2 pr-3 text-right text-muted-foreground">
                      {b.stdErrorNW.toFixed(3)}
                    </td>
                    <td className="numeric py-2 pr-3 text-right">{b.tStat.toFixed(1)}</td>
                    <td className="numeric py-2 pr-3 text-right text-muted-foreground">
                      {b.pValue < 0.001 ? '<0.001' : b.pValue.toFixed(3)}
                    </td>
                    <td className="py-2 text-muted-foreground">{MEANING[b.name] ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.window.truncated && (
            <div className="rounded-md border border-[hsl(var(--warning))]/40 bg-[hsl(var(--warning))]/8 p-3 text-xs leading-relaxed">
              <p className="font-medium">This covers less than the backtest does</p>
              <p className="mt-1 text-muted-foreground">
                The Data Library publishes monthly and currently ends{' '}
                <span className="numeric text-foreground">{data.window.end}</span>, while the
                backtest runs to{' '}
                <span className="numeric text-foreground">{data.window.portfolioEnd}</span>. Those
                last weeks are excluded rather than filled in — a factor return cannot be carried
                forward without inventing market movement that did not happen.
              </p>
            </div>
          )}

          <div className="rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed">
            <p className="font-medium">Reading this honestly</p>
            <p className="mt-1 text-muted-foreground">
              Standard errors are Newey–West with {fit.neweyWestLags} lags. Daily return residuals
              are autocorrelated and change volatility; classical standard errors assume neither
              and come out too small, which makes alpha look significant when it is not. On alpha
              here the Newey–West error is{' '}
              {(fit.alpha.stdErrorNW / fit.alpha.stdError).toFixed(2)}× the classical one
              ({fit.alpha.stdErrorNW.toExponential(2)} against{' '}
              {fit.alpha.stdError.toExponential(2)} per day), and every t-statistic above uses the
              wider figure.
            </p>
            <p className="mt-1.5 text-muted-foreground">
              A factor loading is an exposure over this window, not a fixed property of the
              portfolio. Alpha is measured against <em>these</em> factors — a model that omits the
              risk a strategy actually takes will attribute that risk&rsquo;s return to skill.
            </p>
            <p className="mt-1.5 text-muted-foreground">{data.factorData.attribution}</p>
          </div>
        </CardContent>
      )}
    </Card>
  );
}
