'use client';

import * as React from 'react';
import { Check as CheckIcon, X } from 'lucide-react';
import { Table, TableBody, TableHead, TableHeader, TableRow, TableCell, NumCell, NumHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { Check, CheckKind } from '@/lib/valuation/asts/checks';
import type { Valuation } from './use-asts-valuation';

const GROUPS: Array<{ kind: CheckKind; title: string; note: string }> = [
  {
    kind: 'mechanics',
    title: 'Mechanics — is the arithmetic sound?',
    note: 'These police the engine, not the inputs. No input should trip one; if one fails, the output should not be used.',
  },
  {
    kind: 'reconciliation',
    title: 'Reconciliation — does the model tie to the filings?',
    note: 'The bridge against the 10-Q and the company’s own disclosures. A failure here usually means an edited capital structure.',
  },
  {
    kind: 'plausibility',
    title: 'Plausibility — are the assumptions defensible?',
    note: 'Against benchmarks (Iridium’s margin, satellite capacity, guidance). A failure is information about the inputs, not a broken model.',
  },
];

function fmtValue(c: Check): string {
  if (c.value == null) return 'n/m';
  const v = c.value;
  if (Math.abs(v) >= 100) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(4);
}

export function ChecksTab({ v }: { v: Valuation }) {
  const { checks } = v;
  return (
    <div className="space-y-4">
      <div className={cn(
        'flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm',
        checks.failed === 0 ? 'border-border bg-card' : 'border-negative/40 bg-[hsl(var(--negative))]/5',
      )}>
        {checks.failed === 0 ? <CheckIcon className="size-4 text-positive" aria-hidden /> : <X className="size-4 text-negative" aria-hidden />}
        <span className="font-semibold">{checks.status}</span>
        <span className="text-xs text-muted-foreground">
          {checks.checks.length} live checks, ported from the workbook’s Checks sheet with its labels, values and pass rules. Each was
          shown to fail on a deliberately broken input or run before it was trusted to pass.
        </span>
      </div>
      {GROUPS.map((g) => {
        const list = checks.checks.filter((c) => c.kind === g.kind);
        const failed = list.filter((c) => !c.pass).length;
        return (
          <section key={g.kind} className="overflow-hidden rounded-lg border border-border bg-card" aria-label={g.title}>
            <header className="border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-semibold">
                {g.title} <span className={cn('ml-1 text-xs font-normal', failed ? 'text-negative' : 'text-muted-foreground')}>
                  {failed ? `${failed} of ${list.length} failing` : `${list.length} of ${list.length} pass`}
                </span>
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{g.note}</p>
            </header>
            <div className="overflow-x-auto">
              <Table className="text-xs">
                <TableHeader>
                  <TableRow><NumHead className="w-10">#</NumHead><TableHead>Check</TableHead><NumHead>Value</NumHead><TableHead className="w-16">Result</TableHead><TableHead>Why it matters</TableHead></TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((c) => (
                    <TableRow key={c.id} className={cn(!c.pass && 'bg-[hsl(var(--negative))]/5')}>
                      <NumCell className="text-muted-foreground">{c.id}</NumCell>
                      <TableCell>{c.label}</TableCell>
                      <NumCell>{fmtValue(c)}</NumCell>
                      <TableCell>
                        {c.pass ? (
                          <span className="inline-flex items-center gap-1 text-positive"><CheckIcon className="size-3.5" aria-hidden />Pass</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 font-medium text-negative"><X className="size-3.5" aria-hidden />Fail</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{c.why}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
