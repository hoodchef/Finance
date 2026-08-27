'use client';

import * as React from 'react';
import { AlertTriangle, Check, Sparkles, X } from 'lucide-react';
import type { BacktestConfig, Position } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useWorkspace } from '@/store/workspace';
import { cn } from '@/lib/utils';

interface Symbol {
  symbol: string;
  weight: number;
  name?: string;
  unrecognised: boolean;
}

interface Proposal {
  name: string;
  positions: Position[];
  symbols: Symbol[];
  config: BacktestConfig;
  defaulted: string[];
  notes: string;
  warnings: string[];
}

/**
 * Describe a portfolio in words; a local model proposes one.
 *
 * Two rules shape this component.
 *
 * It only appears when a local daemon is answering, so the product is
 * unchanged for anyone not running one — the same treatment the optional
 * database and API keys get.
 *
 * And it never applies anything. The proposal is rendered for review, with
 * every unrecognised ticker flagged and every defaulted field named, and the
 * user presses Use. A model that misreads a request produces a wrong screen,
 * not a wrong portfolio.
 */
export function AskPanel() {
  const setDraft = useWorkspace((s) => s.setDraft);
  const setConfig = useWorkspace((s) => s.setConfig);
  const draft = useWorkspace((s) => s.draft);

  const [available, setAvailable] = React.useState<boolean | null>(null);
  const [modelWarning, setModelWarning] = React.useState<string | null>(null);
  const [text, setText] = React.useState('');
  const [proposal, setProposal] = React.useState<Proposal | null>(null);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch('/api/ask')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setAvailable(Boolean(d.status?.available));
        setModelWarning(d.status?.warning ?? null);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function ask() {
    if (!text.trim() || pending) return;
    setPending(true);
    setError(null);
    setProposal(null);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: text }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not interpret that.');
      setProposal(json.proposal as Proposal);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not interpret that.');
    } finally {
      setPending(false);
    }
  }

  function use() {
    if (!proposal) return;
    setDraft({ ...draft, name: proposal.name, positions: proposal.positions });
    setConfig(proposal.config);
    setProposal(null);
    setText('');
  }

  // Absent daemon, absent feature. Nothing to explain and nothing to dismiss.
  if (available !== true) return null;

  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium">Describe it instead</span>
        <Badge variant="outline">Local model</Badge>
      </div>

      <div className="mt-2 flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void ask();
          }}
          placeholder="A 60/40 with a gold sleeve, tested since 2010"
          className="h-8 text-xs"
        />
        <Button size="sm" onClick={ask} disabled={pending || !text.trim()}>
          {pending ? 'Thinking…' : 'Propose'}
        </Button>
      </div>

      <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
        Runs on your machine and goes nowhere else. It picks tickers and weights; every number
        after that is still computed by the engine.
      </p>

      {modelWarning && (
        <p className="mt-1.5 text-2xs leading-relaxed text-[hsl(var(--warning))]">{modelWarning}</p>
      )}

      {error && (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-destructive/40 bg-destructive/8 p-2 text-2xs leading-relaxed">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
          <span>{error}</span>
        </div>
      )}

      {proposal && (
        <div className="mt-2 rounded border border-border bg-card p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">{proposal.name}</span>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
                <X className="h-3 w-3" />
                Discard
              </Button>
              <Button size="sm" onClick={use}>
                <Check className="h-3 w-3" />
                Use this
              </Button>
            </div>
          </div>

          <div className="mt-2 space-y-1">
            {proposal.symbols.map((s) => (
              <div key={s.symbol} className="flex items-baseline gap-2 text-2xs">
                <span
                  className={cn(
                    'numeric font-medium',
                    s.unrecognised && 'text-[hsl(var(--warning))]',
                  )}
                >
                  {s.symbol}
                </span>
                <span className="numeric text-muted-foreground">{s.weight}%</span>
                <span className="truncate text-muted-foreground">
                  {s.name ?? (s.unrecognised ? 'not in the local symbol list' : '')}
                </span>
              </div>
            ))}
          </div>

          <div className="numeric mt-2 text-2xs text-muted-foreground">
            {proposal.config.start} → {proposal.config.end} · {proposal.config.rebalance} ·{' '}
            ${proposal.config.initialInvestment.toLocaleString()}
          </div>

          {proposal.warnings.map((w) => (
            <p key={w} className="mt-1.5 text-2xs leading-relaxed text-[hsl(var(--warning))]">
              {w}
            </p>
          ))}

          {proposal.defaulted.length > 0 && (
            <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
              Not mentioned, so left at the default: {proposal.defaulted.join(', ')}.
            </p>
          )}

          {proposal.notes && (
            <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
              It said: {proposal.notes}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
