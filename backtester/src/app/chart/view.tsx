'use client';

import * as React from 'react';
import { Search, X } from 'lucide-react';
import { PageBody, PageHeader } from '@/components/layout/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency, formatCurrencyCompact, formatPercent } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Charting.
 * =============================================================================
 * The organising idea is that this page has ONE subject and several lenses on
 * it, rather than several widgets that happen to share a ticker.
 *
 * The consequence that shapes the layout: the context rail is time-linked. On
 * most platforms a chart shows five years of history beside a sidebar of
 * today's figures, and the two never refer to the same moment — you read a
 * 2019 drawdown next to a 2026 P/E. Here, moving the cursor moves the rail:
 * the price, the change, and the nearest corporate event are all as of the bar
 * under the cursor. Where a figure genuinely has no historical series behind
 * it, it is labelled as current rather than silently implying otherwise.
 *
 * Events get their own lane below the price surface instead of pins on it.
 * Dividends and splits matter for reading a chart — a 4-for-1 split is the
 * difference between a crash and a non-event — but drawn on the price they add
 * clutter exactly where precision matters most.
 */

export interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ChartEvent {
  date: string;
  kind: 'dividend' | 'split' | 'earnings' | 'ticker-change';
  label: string;
}

interface SearchHit {
  ticker: string;
  name: string;
  type?: string;
}

interface FundamentalsBrief {
  company: { ticker: string; name: string };
  valuation: {
    price: number; marketCap: number | null; peRatio: number | null;
    psRatio: number | null; pbRatio: number | null; evToEbitda: number | null;
    fcfYield: number | null; dividendYield: number | null; payoutRatio: number | null;
  } | null;
  rows: Array<{ fiscalYear: number; revenue: number | null; netIncome: number | null;
    epsDiluted: number | null; netMargin: number | null; revenueGrowth: number | null }>;
  provenance: { latestFilingDate: string };
}

interface ChartResponse {
  ticker: string;
  name: string | null;
  bars: Bar[];
  events: ChartEvent[];
  note: string | null;
  provenance: { source: string; latency: string; fetchedAt: string } | null;
}

/** Ranges the free Polygon tier can actually serve — roughly two years. */
const RANGES = [
  { id: '1M', label: '1M', days: 30, span: 'day' },
  { id: '3M', label: '3M', days: 91, span: 'day' },
  { id: '6M', label: '6M', days: 182, span: 'day' },
  { id: 'YTD', label: 'YTD', days: 0, span: 'day' },
  { id: '1Y', label: '1Y', days: 365, span: 'day' },
  { id: '2Y', label: '2Y', days: 730, span: 'day' },
] as const;

type RangeId = (typeof RANGES)[number]['id'];
type ChartKind = 'candles' | 'line' | 'area';

const iso = (d: Date) => d.toISOString().slice(0, 10);

function rangeStart(id: RangeId): string {
  const now = new Date();
  if (id === 'YTD') return `${now.getUTCFullYear()}-01-01`;
  const days = RANGES.find((r) => r.id === id)?.days ?? 365;
  return iso(new Date(now.getTime() - days * 86_400_000));
}

/* ------------------------------------------------------------------ */
/* Chart surface                                                       */
/* ------------------------------------------------------------------ */

/**
 * The price surface.
 *
 * SVG rather than canvas: at the bar counts this data source can return —
 * roughly 500 daily bars over two years — SVG stays smooth, and it gives every
 * bar a real DOM node, which makes the crosshair hit-testing exact rather than
 * inferred from pixel maths.
 *
 * Colours are read from theme tokens through CSS custom properties so the four
 * themes all work; nothing here is a literal colour.
 */
function ChartSurface({
  bars,
  kind,
  height = 380,
  onHover,
  hovered,
  logScale,
  compare = [],
}: {
  bars: Bar[];
  kind: ChartKind;
  height?: number;
  onHover: (index: number | null) => void;
  hovered: number | null;
  logScale: boolean;
  /** Normalised comparison overlays, drawn on their own 0-100% scale. */
  compare?: Array<{ ticker: string; bars: Bar[] }>;
}) {
  const ref = React.useRef<SVGSVGElement>(null);
  const [width, setWidth] = React.useState(900);

  React.useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const padding = { top: 8, right: 56, bottom: 18, left: 8 };
  const priceH = height * 0.76;
  const volH = height - priceH - padding.bottom;
  const innerW = Math.max(40, width - padding.left - padding.right);

  const { xOf, yOf, vOf, lo, hi, ticks } = React.useMemo(() => {
    if (!bars.length) {
      return { xOf: () => 0, yOf: () => 0, vOf: () => 0, lo: 0, hi: 1, ticks: [] as number[] };
    }
    let min = Infinity;
    let max = -Infinity;
    let vMax = 0;
    for (const b of bars) {
      if (b.low < min) min = b.low;
      if (b.high > max) max = b.high;
      if (b.volume > vMax) vMax = b.volume;
    }
    // A little headroom so the extremes are not welded to the frame.
    const pad = (max - min) * 0.06 || 1;
    const l = Math.max(logScale ? 1e-6 : -Infinity, min - pad);
    const h = max + pad;

    const project = (v: number) =>
      logScale
        ? (Math.log(Math.max(v, 1e-9)) - Math.log(l)) / (Math.log(h) - Math.log(l) || 1)
        : (v - l) / (h - l || 1);

    const step = innerW / Math.max(1, bars.length);
    const t: number[] = [];
    for (let i = 0; i <= 4; i++) t.push(l + ((h - l) * i) / 4);

    return {
      xOf: (i: number) => padding.left + i * step + step / 2,
      yOf: (v: number) => padding.top + (1 - project(v)) * (priceH - padding.top),
      vOf: (v: number) => (vMax > 0 ? (v / vMax) * volH : 0),
      lo: l,
      hi: h,
      ticks: t,
    };
  }, [bars, innerW, priceH, volH, logScale, padding.left, padding.top]);

  const step = innerW / Math.max(1, bars.length);
  const bodyW = Math.max(1, Math.min(9, step * 0.68));

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || !bars.length) return;
    const x = e.clientX - rect.left - padding.left;
    const i = Math.round((x - step / 2) / step);
    onHover(Math.max(0, Math.min(bars.length - 1, i)));
  };

  if (!bars.length) {
    return (
      <div
        style={{ height }}
        className="flex items-center justify-center text-xs text-muted-foreground"
      >
        No price history to draw.
      </div>
    );
  }

  const linePath = bars
    .map((b, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(2)},${yOf(b.close).toFixed(2)}`)
    .join(' ');
  const areaPath = `${linePath} L${xOf(bars.length - 1).toFixed(2)},${priceH} L${xOf(0).toFixed(2)},${priceH} Z`;

  const first = bars[0].close;
  const last = bars[bars.length - 1].close;
  const rising = last >= first;

  return (
    <svg
      ref={ref}
      width="100%"
      height={height}
      onMouseMove={handleMove}
      onMouseLeave={() => onHover(null)}
      className="select-none"
      role="img"
      aria-label="Price history"
    >
      {/* Horizontal guides and the price axis. */}
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={padding.left}
            x2={padding.left + innerW}
            y1={yOf(t)}
            y2={yOf(t)}
            stroke="hsl(var(--grid))"
            strokeWidth={1}
          />
          <text
            x={padding.left + innerW + 6}
            y={yOf(t) + 3}
            className="numeric"
            fontSize={10}
            fill="hsl(var(--muted-foreground))"
          >
            {t >= 1000 ? t.toFixed(0) : t.toFixed(2)}
          </text>
        </g>
      ))}

      {kind === 'candles' ? (
        bars.map((b, i) => {
          const up = b.close >= b.open;
          const colour = up ? 'hsl(var(--positive))' : 'hsl(var(--negative))';
          const yO = yOf(b.open);
          const yC = yOf(b.close);
          return (
            <g key={b.date}>
              <line
                x1={xOf(i)}
                x2={xOf(i)}
                y1={yOf(b.high)}
                y2={yOf(b.low)}
                stroke={colour}
                strokeWidth={1}
              />
              <rect
                x={xOf(i) - bodyW / 2}
                y={Math.min(yO, yC)}
                width={bodyW}
                height={Math.max(1, Math.abs(yC - yO))}
                fill={colour}
              />
            </g>
          );
        })
      ) : (
        <>
          {kind === 'area' && (
            <path
              d={areaPath}
              fill={rising ? 'hsl(var(--positive))' : 'hsl(var(--negative))'}
              fillOpacity={0.1}
            />
          )}
          <path
            d={linePath}
            fill="none"
            stroke={rising ? 'hsl(var(--positive))' : 'hsl(var(--negative))'}
            strokeWidth={1.5}
          />
        </>
      )}

      {/* Volume, sharing the x-scale. */}
      {bars.map((b, i) => (
        <rect
          key={`v-${b.date}`}
          x={xOf(i) - bodyW / 2}
          y={height - padding.bottom - vOf(b.volume)}
          width={bodyW}
          height={vOf(b.volume)}
          fill={b.close >= b.open ? 'hsl(var(--positive))' : 'hsl(var(--negative))'}
          fillOpacity={0.28}
        />
      ))}

      {/*
        Comparisons are rebased to their own first close and drawn against the
        base security's percentage range, not its price. Overlaying raw prices
        would make a $600 stock dwarf a $30 one and say nothing about which
        performed better, which is the only question a comparison answers.
      */}
      {compare.map((c, ci) => {
        if (c.bars.length < 2) return null;
        const baseFirst = bars[0].close;
        const baseLast = bars[bars.length - 1].close;
        const cFirst = c.bars[0].close;
        // Map the comparison's return onto the base's price axis.
        const toPrice = (v: number) => baseFirst * (v / cFirst);
        const n = Math.min(c.bars.length, bars.length);
        const d = Array.from({ length: n }, (_, i) => {
          const price = toPrice(c.bars[Math.floor((i / n) * c.bars.length)].close);
          return `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(2)},${yOf(price).toFixed(2)}`;
        }).join(' ');
        return (
          <path
            key={c.ticker}
            d={d}
            fill="none"
            stroke={`hsl(var(--series-${(ci + 2) % 15}))`}
            strokeWidth={1.25}
            strokeOpacity={0.9}
          />
        );
      })}

      {/* Crosshair. */}
      {hovered != null && bars[hovered] && (
        <g pointerEvents="none">
          <line
            x1={xOf(hovered)}
            x2={xOf(hovered)}
            y1={padding.top}
            y2={height - padding.bottom}
            stroke="hsl(var(--foreground))"
            strokeOpacity={0.35}
            strokeDasharray="3 3"
          />
          <circle
            cx={xOf(hovered)}
            cy={yOf(bars[hovered].close)}
            r={3}
            fill="hsl(var(--foreground))"
          />
        </g>
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function ChartView() {
  const [query, setQuery] = React.useState('');
  const [hits, setHits] = React.useState<SearchHit[]>([]);
  const [open, setOpen] = React.useState(false);
  const [ticker, setTicker] = React.useState('AAPL');
  const [range, setRange] = React.useState<RangeId>('1Y');
  const [kind, setKind] = React.useState<ChartKind>('candles');
  const [logScale, setLogScale] = React.useState(false);
  const [data, setData] = React.useState<ChartResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [hovered, setHovered] = React.useState<number | null>(null);
  const [fundamentals, setFundamentals] = React.useState<FundamentalsBrief | null>(null);
  const [fundamentalsNote, setFundamentalsNote] = React.useState<string | null>(null);
  const [compare, setCompare] = React.useState<Array<{ ticker: string; bars: Bar[] }>>([]);

  /* Autocomplete. Debounced so a fast typist does not spend the rate limit. */
  React.useEffect(() => {
    if (query.trim().length < 1) {
      setHits([]);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const res = await fetch('/api/chart/search', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query: query.trim() }),
        });
        const body = await res.json();
        setHits(Array.isArray(body.results) ? body.results.slice(0, 8) : []);
      } catch {
        setHits([]);
      }
    }, 220);
    return () => window.clearTimeout(t);
  }, [query]);

  const load = React.useCallback(async (symbol: string, r: RangeId) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/chart', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ticker: symbol,
          timespan: 'day',
          from: rangeStart(r),
          to: iso(new Date()),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'Could not load price history.');
        setData(null);
        return;
      }
      setData(body as ChartResponse);
    } catch {
      setError('Could not load price history.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load(ticker, range);
  }, [ticker, range, load]);

  /*
   * Fundamentals come from the existing SEC EDGAR route, not from the price
   * vendor: it is the primary source, public domain and unmetered, and it is
   * already verified by the Research page. Reusing it means the chart shows
   * filed figures rather than a vendor's transcription of them.
   */
  React.useEffect(() => {
    let cancelled = false;
    setFundamentals(null);
    setFundamentalsNote(null);
    fetch('/api/fundamentals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticker }),
    })
      .then(async (res) => {
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) setFundamentalsNote(body.error ?? 'No filed fundamentals for this symbol.');
        else setFundamentals(body as FundamentalsBrief);
      })
      .catch(() => {
        if (!cancelled) setFundamentalsNote('Fundamentals could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  /** Adds a security to the comparison overlay, normalised at the chart start. */
  const addComparison = React.useCallback(
    async (symbol: string) => {
      const up = symbol.trim().toUpperCase();
      if (!up || up === ticker || compare.some((c) => c.ticker === up) || compare.length >= 4) return;
      try {
        const res = await fetch('/api/chart', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ticker: up, timespan: 'day', from: rangeStart(range), to: iso(new Date()),
          }),
        });
        const body = await res.json();
        if (res.ok && Array.isArray(body.bars) && body.bars.length) {
          setCompare((c) => [...c, { ticker: up, bars: body.bars as Bar[] }]);
        }
      } catch {
        /* A comparison that will not load is left out rather than shown empty. */
      }
    },
    [ticker, range, compare],
  );

  // Comparisons are priced off the base range; changing it invalidates them.
  React.useEffect(() => {
    setCompare([]);
  }, [range, ticker]);

  const bars = data?.bars ?? [];
  const active = hovered != null ? bars[hovered] : bars[bars.length - 1];
  const first = bars[0];

  /* Change measured to the bar under the cursor, not always to today. */
  const change =
    first && active ? (active.close - first.close) / first.close : null;

  const nearestEvent = React.useMemo(() => {
    if (!active || !data?.events?.length) return null;
    return [...data.events]
      .filter((e) => e.date <= active.date)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0] ?? null;
  }, [active, data]);

  return (
    <>
      <PageHeader
        title="Charts"
        description="Search any security and read its price, events and fundamentals together."
      />

      <PageBody className="space-y-4">
        {/* Search and controls */}
        <Card>
          <CardContent className="space-y-3 p-4">
            <div className="relative max-w-xl">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && query.trim()) {
                    setTicker(query.trim().toUpperCase());
                    setOpen(false);
                    setQuery('');
                  }
                  if (e.key === 'Escape') setOpen(false);
                }}
                placeholder="Search a ticker or company — AAPL, Microsoft, BTC…"
                className="pl-8 text-xs"
                aria-label="Search securities"
              />
              {open && hits.length > 0 && (
                <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-lg">
                  {hits.map((h) => (
                    <button
                      key={h.ticker}
                      type="button"
                      onClick={() => {
                        setTicker(h.ticker);
                        setQuery('');
                        setOpen(false);
                      }}
                      className="flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left hover:bg-accent"
                    >
                      <span className="numeric text-xs font-medium">{h.ticker}</span>
                      <span className="truncate text-2xs text-muted-foreground">{h.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex gap-0.5">
                {RANGES.map((r) => (
                  <Button
                    key={r.id}
                    size="sm"
                    variant={range === r.id ? 'secondary' : 'ghost'}
                    className="h-7 px-2 text-2xs"
                    onClick={() => setRange(r.id)}
                  >
                    {r.label}
                  </Button>
                ))}
              </div>

              <div className="flex gap-0.5">
                {(['candles', 'line', 'area'] as const).map((k) => (
                  <Button
                    key={k}
                    size="sm"
                    variant={kind === k ? 'secondary' : 'ghost'}
                    className="h-7 px-2 text-2xs capitalize"
                    onClick={() => setKind(k)}
                  >
                    {k}
                  </Button>
                ))}
              </div>

              <Button
                size="sm"
                variant={logScale ? 'secondary' : 'ghost'}
                className="h-7 px-2 text-2xs"
                onClick={() => setLogScale((v) => !v)}
              >
                Log
              </Button>

              <div className="flex items-center gap-1.5">
                <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                  Compare
                </span>
                <Input
                  placeholder="+ symbol"
                  className="h-7 w-24 text-2xs"
                  aria-label="Add a security to compare"
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    const v = (e.target as HTMLInputElement).value;
                    void addComparison(v);
                    (e.target as HTMLInputElement).value = '';
                  }}
                />
                {compare.map((c, i) => (
                  <Badge
                    key={c.ticker}
                    variant="outline"
                    className="gap-1 py-0.5 text-2xs font-normal"
                    style={{ borderColor: `hsl(var(--series-${(i + 2) % 15}))` }}
                  >
                    <span className="numeric">{c.ticker}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${c.ticker}`}
                      onClick={() => setCompare((x) => x.filter((y) => y.ticker !== c.ticker))}
                      className="rounded hover:text-negative"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </Badge>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {error && (
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-[hsl(var(--negative))]">{error}</p>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
          {/* Price surface */}
          <Card className="min-w-0">
            <CardContent className="p-4">
              <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="numeric text-lg font-semibold">{data?.ticker ?? ticker}</span>
                {data?.name && (
                  <span className="truncate text-xs text-muted-foreground">{data.name}</span>
                )}
                {active && (
                  <>
                    <span className="numeric text-lg font-semibold">
                      {formatCurrency(active.close)}
                    </span>
                    {change != null && (
                      <span
                        className={cn(
                          'numeric text-xs font-medium',
                          change >= 0 ? 'text-positive' : 'text-negative',
                        )}
                      >
                        {change >= 0 ? '+' : ''}
                        {formatPercent(change, 2)}
                      </span>
                    )}
                    <span className="numeric text-2xs text-muted-foreground">{active.date}</span>
                  </>
                )}
              </div>

              {loading && !bars.length ? (
                <Skeleton className="h-[380px] w-full" />
              ) : (
                <ChartSurface
                  bars={bars}
                  kind={kind}
                  onHover={setHovered}
                  hovered={hovered}
                  logScale={logScale}
                  compare={compare}
                />
              )}

              {/* Event lane, kept off the price surface. */}
              {data?.events && data.events.length > 0 && (
                <div className="mt-2 border-t border-border pt-2">
                  <div className="mb-1 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Events
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {data.events.slice(0, 14).map((e) => (
                      <Badge key={`${e.date}-${e.label}`} variant="outline" className="text-2xs font-normal">
                        <span className="numeric">{e.date}</span>
                        <span className="ml-1">{e.label}</span>
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Time-linked context rail */}
          <Card className="min-w-0">
            <CardContent className="space-y-3 p-4">
              <div className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                {hovered != null ? 'At the cursor' : 'Latest bar'}
              </div>

              {active ? (
                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                  <Field label="Date" value={active.date} />
                  <Field label="Close" value={formatCurrency(active.close)} />
                  <Field label="Open" value={formatCurrency(active.open)} />
                  <Field label="High" value={formatCurrency(active.high)} />
                  <Field label="Low" value={formatCurrency(active.low)} />
                  <Field label="Volume" value={active.volume.toLocaleString()} />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No bar selected.</p>
              )}

              {nearestEvent && (
                <div className="border-t border-border pt-3">
                  <div className="text-2xs uppercase tracking-wide text-muted-foreground">
                    Most recent event
                  </div>
                  <div className="text-xs font-medium">{nearestEvent.label}</div>
                  <div className="numeric text-2xs text-muted-foreground">{nearestEvent.date}</div>
                </div>
              )}

              {bars.length > 0 && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border pt-3">
                  <Field label="Bars" value={String(bars.length)} />
                  <Field
                    label="Period high"
                    value={formatCurrency(Math.max(...bars.map((b) => b.high)))}
                  />
                  <Field
                    label="Period low"
                    value={formatCurrency(Math.min(...bars.map((b) => b.low)))}
                  />
                  <Field label="From" value={bars[0].date} />
                </div>
              )}

              {fundamentals?.valuation && (
                <div className="border-t border-border pt-3">
                  <div className="mb-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Valuation · filed to {fundamentals.provenance.latestFilingDate}
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                    <Field label="P/E" value={fmtMult(fundamentals.valuation.peRatio)} />
                    <Field label="P/S" value={fmtMult(fundamentals.valuation.psRatio)} />
                    <Field label="P/B" value={fmtMult(fundamentals.valuation.pbRatio)} />
                    <Field label="EV/EBITDA" value={fmtMult(fundamentals.valuation.evToEbitda)} />
                    <Field label="FCF yield" value={fmtPct(fundamentals.valuation.fcfYield)} />
                    <Field label="Dividend yield" value={fmtPct(fundamentals.valuation.dividendYield)} />
                  </div>
                  {fundamentals.rows.length > 0 && (
                    <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 border-t border-border pt-3">
                      <Field
                        label={`FY${fundamentals.rows[fundamentals.rows.length - 1].fiscalYear} revenue`}
                        value={fmtMoney(fundamentals.rows[fundamentals.rows.length - 1].revenue)}
                      />
                      <Field
                        label="Revenue growth"
                        value={fmtPct(fundamentals.rows[fundamentals.rows.length - 1].revenueGrowth)}
                      />
                      <Field
                        label="Net margin"
                        value={fmtPct(fundamentals.rows[fundamentals.rows.length - 1].netMargin)}
                      />
                      <Field
                        label="Diluted EPS"
                        value={
                          fundamentals.rows[fundamentals.rows.length - 1].epsDiluted?.toFixed(2) ?? '—'
                        }
                      />
                    </div>
                  )}
                  <p className="mt-2 text-2xs text-muted-foreground">
                    Filed figures from SEC EDGAR, on the last full fiscal year — not a trailing
                    twelve months, and not the price vendor&rsquo;s transcription.
                  </p>
                </div>
              )}

              {!fundamentals && fundamentalsNote && (
                <p className="rounded-md border border-border bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
                  {fundamentalsNote}
                </p>
              )}

              {data?.provenance && (
                <p className="rounded-md border border-border bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
                  {data.provenance.source}, {data.provenance.latency}. Prices are split and
                  dividend adjusted where the provider supplies the factors.
                </p>
              )}
              {data?.note && (
                <p className="rounded-md border border-border bg-muted/40 p-2.5 text-xs leading-relaxed text-muted-foreground">
                  {data.note}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </PageBody>
    </>
  );
}

const fmtMult = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)}\u00d7`);
const fmtPct = (v: number | null) => (v == null ? '—' : formatPercent(v, 1));
const fmtMoney = (v: number | null) => (v == null ? '—' : formatCurrencyCompact(v));

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="numeric text-sm font-medium">{value}</div>
    </div>
  );
}
