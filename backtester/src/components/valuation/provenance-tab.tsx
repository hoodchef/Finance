'use client';

import * as React from 'react';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell } from '@/components/ui/table';
import { MODEL_META } from '@/lib/valuation/asts/inputs';
import { NOTES, REVIEW_LOG, SOURCES } from './provenance.generated';
import type { Valuation } from './use-asts-valuation';
import { pct, usd } from './format';

function Frame({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card" aria-label={title}>
      <header className="border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {note && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{note}</p>}
      </header>
      {children}
    </section>
  );
}

const STATUS_VARIANT: Record<string, 'positive' | 'warning' | 'outline' | 'default'> = {
  Resolved: 'positive',
  Fixed: 'positive',
  Pass: 'positive',
  Documented: 'outline',
  'Open (data)': 'warning',
};

export function ProvenanceTab({ v }: { v: Valuation }) {
  const { live } = v;
  const rec = live?.market?.reconciliation;
  const f = live?.filings;
  const method = NOTES.filter((n) => !n.title.startsWith('HOW TO USE'));

  return (
    <div className="space-y-4">
      <Frame title="How this page is verified">
        <div className="space-y-2 p-4 text-xs leading-relaxed text-muted-foreground">
          <p>
            This page runs a TypeScript port of the analyst’s model. The analyst’s own package — an engine written independently of the
            workbook’s formulas, and the workbook itself — is kept in the repository unmodified, and the port is held to both: every row,
            period and scenario of the engine to within 1e-9, and the workbook’s cached values for everything the engine does not compute
            (market statistics, diagnostics, the sensitivity grid, the funding table, and all 44 checks). The engine and the workbook
            themselves agree to 1.2e-14 across 2,560 cells.
          </p>
          <p>
            Beyond the delivered inputs, the port is held to the reference at 33 cases built so that a specific branch binds — straight-line
            tax depreciation, the NOL cap, the CIP pool, the launch clamp, the capped-call trigger, delay, the limited-liability floor — and
            at 20 random perturbations of every input at once. Eight deliberate breaks were introduced into the engine; the suite caught
            every one. The simulation cannot share numpy’s random stream, so it is held to the analyst’s 20,000 paths statistically, with
            everything downstream of the random numbers pinned exactly.
          </p>
          <p>
            The expansions — financing-adjusted value, the runway, the live market layer, filing freshness — are the port’s own and are
            labelled as such wherever they appear. The financing module reproduces the Risk sheet’s funding gaps and, raised at fair value,
            returns the model’s value exactly.
          </p>
        </div>
      </Frame>

      <div className="grid gap-4 xl:grid-cols-2">
        <Frame
          title="Live market data against the snapshot"
          note="Before a live figure is shown beside the model’s, the two feeds’ weekly closes are compared over the weeks they share."
        >
          <div className="p-4 text-xs leading-relaxed">
            {rec && live?.market ? (
              <Table className="text-xs">
                <TableBody>
                  <TableRow><TableCell className="text-muted-foreground">Live source</TableCell><TableCell>{live.market.source}, to {live.market.asOf}</TableCell></TableRow>
                  <TableRow><TableCell className="text-muted-foreground">ASTS weekly closes compared</TableCell>
                    <TableCell>{rec.asts.weeksCompared} weeks · largest difference {pct(rec.asts.maxAbsPctDiff, 3)}</TableCell></TableRow>
                  <TableRow><TableCell className="text-muted-foreground">SPY weekly closes compared</TableCell>
                    <TableCell>{rec.spy.weeksCompared} weeks · largest difference {pct(rec.spy.maxAbsPctDiff, 3)}</TableCell></TableRow>
                  {rec.asts.worst && (
                    <TableRow><TableCell className="text-muted-foreground">Worst ASTS week</TableCell>
                      <TableCell>{rec.asts.worst.week}: snapshot {usd(rec.asts.worst.snapshot)}, live {usd(rec.asts.worst.live)}</TableCell></TableRow>
                  )}
                  <TableRow><TableCell className="text-muted-foreground">Live beta (Blume) / snapshot</TableCell>
                    <TableCell>{live.market.stats.betaAdj.toFixed(3)} / {v.snapshot.betaAdj.toFixed(3)}</TableCell></TableRow>
                </TableBody>
              </Table>
            ) : (
              <p className="text-muted-foreground">{live ? live.marketNote : 'Checking…'}</p>
            )}
          </div>
        </Frame>
        <Frame title="Filings since the model" note={`Balance sheet ${MODEL_META.balanceSheetDate}; valuation date ${MODEL_META.valuationDate}. Checked against SEC EDGAR on load.`}>
          <div className="space-y-2 p-4 text-xs leading-relaxed">
            {f ? (
              <>
                <p className="flex items-start gap-2">
                  <Badge variant={f.freshness === 'current' ? 'positive' : 'warning'} className="shrink-0 capitalize">{f.freshness}</Badge>
                  <span className="text-muted-foreground">{f.headline}</span>
                </p>
                {f.latestPeriodic && (
                  <p className="text-muted-foreground">
                    Latest periodic report:{' '}
                    <a href={f.latestPeriodic.url} target="_blank" rel="noopener noreferrer" className="text-foreground underline underline-offset-2">
                      {f.latestPeriodic.form} for {f.latestPeriodic.period}, filed {f.latestPeriodic.filed}
                    </a>
                  </p>
                )}
                {f.sinceValuation.length > 0 && (
                  <ul className="space-y-1">
                    {f.sinceValuation.map((x) => (
                      <li key={x.url}>
                        <a href={x.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{x.form}</a>{' '}
                        <span className="text-muted-foreground">filed {x.filed} — {x.description}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">{live ? live.filingsNote : 'Checking…'}</p>
            )}
          </div>
        </Frame>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {method.map((n) => (
          <Frame key={n.title} title={n.title.charAt(0) + n.title.slice(1).toLowerCase().replace('review_log', 'Review Log')}>
            <ul className="space-y-1.5 p-4 text-xs leading-relaxed text-muted-foreground">
              {n.lines.map((l) => <li key={l}>{l}</li>)}
            </ul>
          </Frame>
        ))}
      </div>

      <Frame
        title="Review log"
        note="The analyst’s findings, challenges and resolutions, verbatim. A1 = lead analyst, A2 = quant/data, A3 = senior model reviewer. Open items are data the model is still waiting for — they are not guessed."
      >
        <div className="overflow-x-auto">
          <Table className="text-xs">
            <TableHeader>
              <TableRow><TableHead>ID</TableHead><TableHead className="min-w-56">Finding</TableHead><TableHead className="min-w-64">Evidence</TableHead><TableHead className="min-w-64">Resolution</TableHead><TableHead>Status</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {REVIEW_LOG.map((r) => (
                <TableRow key={r.id} className="align-top">
                  <TableCell className="numeric whitespace-nowrap font-medium">{r.id}<span className="block text-2xs font-normal text-muted-foreground">{r.raised}</span></TableCell>
                  <TableCell>{r.finding}</TableCell>
                  <TableCell className="text-muted-foreground">{r.evidence}</TableCell>
                  <TableCell className="text-muted-foreground">{r.resolution}</TableCell>
                  <TableCell><Badge variant={STATUS_VARIANT[r.status] ?? 'default'} className="whitespace-nowrap">{r.status}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Frame>

      <Frame title="Sources" note="Every hard-coded fact in the inputs traces to one of these.">
        <ul className="divide-y divide-border text-xs">
          {SOURCES.map((s) => (
            <li key={s.label} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2">
              <span>{s.label}</span>
              {s.ref.startsWith('http') ? (
                <a href={s.ref} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-muted-foreground underline underline-offset-2">
                  <span className="truncate">{new URL(s.ref).hostname.replace(/^www\./, '')}</span><ExternalLink className="size-3 shrink-0" aria-hidden />
                </a>
              ) : (
                <span className="text-muted-foreground">{s.ref}</span>
              )}
            </li>
          ))}
        </ul>
      </Frame>
    </div>
  );
}
