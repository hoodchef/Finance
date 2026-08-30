'use client';

import * as React from 'react';
import { ChevronDown, Plus, RotateCcw, X } from 'lucide-react';
import { MAX_HISTORY_START, RANGE_PRESETS } from '@/lib/defaults';
import { addYears, todayIso } from '@/lib/market-data/dates';
import { useWorkspace } from '@/store/workspace';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { InfoTip } from '@/components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TickerSearch } from '@/components/builder/ticker-search';
import { CashflowLegs } from './cashflow-legs';
import { StrategyBuilder } from './strategy-builder';
import { cn } from '@/lib/utils';

function Section({
  title,
  hint,
  children,
  className,
}: {
  title: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('space-y-2.5', className)}>
      <h3 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
        {hint && <InfoTip label={`About ${title}`}>{hint}</InfoTip>}
      </h3>
      {children}
    </section>
  );
}

/**
 * The settings most people never touch, behind one click.
 *
 * The panel had twelve sections in a flat scroll, all at the same visual
 * weight: the period and the strategy sat level with the cost-basis method and
 * the risk-free source. Five of the twelve carry almost every run, and the
 * other seven are answered once and then scrolled past forever.
 *
 * Collapsed rather than removed, and the summary names what is inside — a
 * disclosure that hides its contents behind the word "Advanced" alone makes
 * people open it every time to check, which is worse than leaving it open.
 */
function AdvancedSettings({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="border-t border-border pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          Cashflows, dividends, inflation, currency, cost basis, fees, risk-free
        </span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>
      {open && <div className="mt-4 space-y-5">{children}</div>}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && <InfoTip label={`About ${label}`}>{hint}</InfoTip>}
      </div>
      {children}
    </div>
  );
}

export function ConfigPanel() {
  const config = useWorkspace((s) => s.config);
  const setConfig = useWorkspace((s) => s.setConfig);
  const setFees = useWorkspace((s) => s.setFees);
  const resetConfig = useWorkspace((s) => s.resetConfig);
  const addBenchmark = useWorkspace((s) => s.addBenchmark);
  const removeBenchmark = useWorkspace((s) => s.removeBenchmark);

  const [showBenchmarkSearch, setShowBenchmarkSearch] = React.useState(false);
  const today = todayIso();

  function applyRangePreset(years: number | 'max') {
    const end = config.end > today ? today : config.end;
    setConfig({
      start: years === 'max' ? MAX_HISTORY_START : addYears(end, -years),
      end,
    });
  }

  const activePreset = RANGE_PRESETS.find((p) => {
    if (p.years === 'max') return config.start === MAX_HISTORY_START;
    return config.start === addYears(config.end, -p.years);
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between pb-3">
        <CardTitle>Backtest settings</CardTitle>
        <Button variant="ghost" size="sm" onClick={resetConfig} className="text-muted-foreground">
          <RotateCcw />
          Reset
        </Button>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* ---------------------------------------------------------- */}
        <Section title="Period">
          <div className="flex flex-wrap gap-1">
            {RANGE_PRESETS.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={activePreset?.id === p.id ? 'default' : 'outline'}
                onClick={() => applyRangePreset(p.years)}
                className="h-7 px-2.5 text-xs"
              >
                {p.label}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start" htmlFor="cfg-start">
              <Input
                id="cfg-start"
                type="date"
                value={config.start}
                min={MAX_HISTORY_START}
                max={config.end}
                onChange={(e) => setConfig({ start: e.target.value })}
                className="text-xs"
              />
            </Field>
            <Field label="End" htmlFor="cfg-end">
              <Input
                id="cfg-end"
                type="date"
                value={config.end}
                min={config.start}
                max={today}
                onChange={(e) => setConfig({ end: e.target.value })}
                className="text-xs"
              />
            </Field>
          </div>
          <Field
            label="If a holding has no history at the start"
            hint="Assets have different inception dates. Truncating moves the whole backtest forward to the latest inception so every holding is present throughout — the honest default. Holding as cash keeps the requested window and leaves that sleeve uninvested until the asset lists."
          >
            <Select
              value={config.inceptionPolicy}
              onValueChange={(v) => setConfig({ inceptionPolicy: v as typeof config.inceptionPolicy })}
            >
              <SelectTrigger className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="truncate">Move the start date forward</SelectItem>
                <SelectItem value="cash">Hold that weight in cash until it lists</SelectItem>
                <SelectItem value="error">Refuse to run</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </Section>
        <Separator />

        {/* ---------------------------------------------------------- */}
        <Section title="Investment">
          <Field label="Initial investment" htmlFor="cfg-initial">
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                $
              </span>
              <Input
                id="cfg-initial"
                type="number"
                min="0"
                step="1000"
                value={config.initialInvestment}
                onChange={(e) => setConfig({ initialInvestment: Number(e.target.value) })}
                className="pl-6 text-xs"
              />
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field
              label={config.contributionIsWithdrawal ? 'Withdrawal' : 'Contribution'}
              htmlFor="cfg-contribution"
            >
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  $
                </span>
                <Input
                  id="cfg-contribution"
                  type="number"
                  min="0"
                  step="100"
                  value={config.contributionAmount}
                  onChange={(e) => setConfig({ contributionAmount: Number(e.target.value) })}
                  className="pl-6 text-xs"
                />
              </div>
            </Field>
            <Field label="Frequency">
              <Select
                value={config.contributionFrequency}
                onValueChange={(v) =>
                  setConfig({ contributionFrequency: v as typeof config.contributionFrequency })
                }
              >
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="annual">Annual</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          {config.contributionFrequency !== 'none' && config.contributionAmount > 0 && (
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border p-2 text-xs">
              <input
                type="checkbox"
                checked={config.contributionIsWithdrawal}
                onChange={(e) => setConfig({ contributionIsWithdrawal: e.target.checked })}
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
              />
              <span>Treat this as a withdrawal instead of a contribution</span>
            </label>
          )}
        </Section>
        <Separator />

        {/* ---------------------------------------------------------- */}
        <Section
          title="Rebalancing"
          hint="Rebalancing sells what has grown past its target and buys what has fallen below it, restoring the weights you set. Trades execute at the close of the first trading day of each period."
        >
          <Select
            value={config.rebalance}
            onValueChange={(v) => setConfig({ rebalance: v as typeof config.rebalance })}
          >
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="never">Never</SelectItem>
              <SelectItem value="monthly">Monthly</SelectItem>
              <SelectItem value="quarterly">Quarterly</SelectItem>
              <SelectItem value="semiannual">Semi-annually</SelectItem>
              <SelectItem value="annual">Annually</SelectItem>
              <SelectItem value="threshold">Custom — drift band</SelectItem>
            </SelectContent>
          </Select>

          {config.rebalance === 'threshold' && (
            <Field
              label="Rebalance when any weight drifts by more than"
              htmlFor="cfg-band"
              hint="Measured in percentage points of the whole portfolio. A 5-point band on a 60% target rebalances when it reaches 65% or 55%."
            >
              <div className="flex items-center gap-2">
                <Input
                  id="cfg-band"
                  type="number"
                  min="0.5"
                  max="50"
                  step="0.5"
                  value={config.rebalanceThresholdPct}
                  onChange={(e) => setConfig({ rebalanceThresholdPct: Number(e.target.value) })}
                  className="w-24 text-xs"
                />
                <span className="text-xs text-muted-foreground">percentage points</span>
              </div>
            </Field>
          )}
        </Section>
        <Separator />

        {/* ---------------------------------------------------------- */}
        <Section
          title="Strategy"
          hint="How target weights are decided at each rebalance. Fixed weights uses what you typed; the other rules make the targets a function of what the market has done, which is the difference between a portfolio and a strategy."
        >
          <StrategyBuilder />
        </Section>
        <Separator />

        {/* ---------------------------------------------------------- */}
        <Section
          title="Benchmarks"
          hint="Each benchmark runs through the same engine with the same contribution schedule, dividends reinvested, and no fees — an index is not a product and charges nothing. The first benchmark is the one used for beta, alpha and tracking error."
        >
          <div className="flex flex-wrap gap-1.5">
            {config.benchmarks.map((b, i) => (
              <Badge key={b} variant={i === 0 ? 'primary' : 'outline'} className="gap-1 py-1 pl-2">
                <span className="numeric">{b}</span>
                {i === 0 && <span className="text-2xs opacity-70">primary</span>}
                <button
                  type="button"
                  aria-label={`Remove benchmark ${b}`}
                  onClick={() => removeBenchmark(b)}
                  className="rounded hover:text-negative focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            {config.benchmarks.length === 0 && (
              <span className="text-xs text-muted-foreground">No benchmarks selected.</span>
            )}
          </div>

          {showBenchmarkSearch ? (
            <TickerSearch
              autoFocus
              placeholder="Add a benchmark…"
              onSelect={(meta) => {
                addBenchmark(meta.symbol);
                setShowBenchmarkSearch(false);
              }}
            />
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              disabled={config.benchmarks.length >= 6}
              onClick={() => setShowBenchmarkSearch(true)}
            >
              <Plus />
              Add benchmark
            </Button>
          )}
        </Section>

        <AdvancedSettings>
        {/* ---------------------------------------------------------- */}
        <Section
          title="Additional cashflows"
          hint="Extra streams that run alongside the recurring contribution above. Several can overlap; flows landing on the same day are netted into one trade."
        >
          <CashflowLegs />
        </Section>
        <Separator />

        {/* ---------------------------------------------------------- */}
        <Section
          title="Dividends and cash"
          hint="Reinvesting buys more shares at the closing price on the ex-dividend date. Taking dividends as cash leaves them in the cash balance, where they earn only the cash yield below."
        >
          <div className="grid grid-cols-2 gap-2">
            <Field label="Dividends">
              <Select
                value={config.dividends}
                onValueChange={(v) => setConfig({ dividends: v as typeof config.dividends })}
              >
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="reinvest">Reinvest</SelectItem>
                  <SelectItem value="cash">Take as cash</SelectItem>
                  <SelectItem value="ignore">Exclude (price return)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field
              label="Cash yield (%/yr)"
              htmlFor="cfg-cash-yield"
              hint="Interest earned on idle cash and on any explicit CASH sleeve. Left at 0 unless you set it — no rate is assumed on your behalf."
            >
              <Input
                id="cfg-cash-yield"
                type="number"
                min="0"
                max="25"
                step="0.25"
                value={config.cashYieldPct}
                onChange={(e) => setConfig({ cashYieldPct: Number(e.target.value) })}
                className="text-xs"
              />
            </Field>
          </div>
        </Section>
        <Separator />

        {/* ---------------------------------------------------------- */}
        <Section
          title="Inflation"
          hint="Real returns answer whether the portfolio bought more at the end than at the start. The CPI option uses the published US series — measured data. A fixed rate is your assumption, and every figure derived from it is labelled as one."
        >
          <Select
            value={config.inflation.mode}
            onValueChange={(v) =>
              setConfig({
                inflation: { ...config.inflation, mode: v as typeof config.inflation.mode },
              })
            }
          >
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Nominal only</SelectItem>
              <SelectItem value="cpi">US CPI (published series)</SelectItem>
              <SelectItem value="constant">Fixed assumed rate</SelectItem>
            </SelectContent>
          </Select>

          {config.inflation.mode === 'constant' && (
            <Field label="Assumed rate (%/yr)" htmlFor="cfg-inflation-rate">
              <Input
                id="cfg-inflation-rate"
                type="number"
                min="-20"
                max="50"
                step="0.1"
                value={config.inflation.constantPct}
                onChange={(e) =>
                  setConfig({
                    inflation: { ...config.inflation, constantPct: Number(e.target.value) },
                  })
                }
                className="text-xs"
              />
            </Field>
          )}

          {config.inflation.mode !== 'off' && config.contributionFrequency !== 'none' && (
            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-xs">
              <input
                type="checkbox"
                checked={config.inflation.adjustContributions}
                onChange={(e) =>
                  setConfig({
                    inflation: { ...config.inflation, adjustContributions: e.target.checked },
                  })
                }
                className="mt-0.5 h-3.5 w-3.5 accent-[hsl(var(--primary))]"
              />
              <span>
                Grow the recurring {config.contributionIsWithdrawal ? 'withdrawal' : 'contribution'}{' '}
                with inflation
                <span className="mt-0.5 block text-2xs text-muted-foreground">
                  Keeps its purchasing power constant, which is usually what &ldquo;
                  {config.contributionIsWithdrawal ? 'withdraw' : 'save'} $
                  {config.contributionAmount.toLocaleString()} a month&rdquo; means.
                </span>
              </span>
            </label>
          )}
        </Section>
        <Separator />

        {/* ---------------------------------------------------------- */}
        <Section
          title="Reporting currency"
          hint="Holdings denominated differently are translated into this before being added together, at the published daily rate. Returns then include currency movement, which is real risk borne by an investor in this currency rather than an artefact. Leave it on automatic and a single-currency portfolio is never converted."
        >
          <Select
            value={config.baseCurrency ?? 'auto'}
            onValueChange={(v) => setConfig({ baseCurrency: v === 'auto' ? undefined : v })}
          >
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Automatic (dominant holding)</SelectItem>
              <SelectItem value="USD">US dollars</SelectItem>
              <SelectItem value="CAD">Canadian dollars</SelectItem>
            </SelectContent>
          </Select>
        </Section>
        <Separator />

        {/* ---------------------------------------------------------- */}
        <Section
          title="Cost basis"
          hint="Determines how a sale is matched against earlier purchases, which splits the portfolio's gain into realised and unrealised. It changes nothing about performance — only which part of the gain has been crystallised. No tax is calculated anywhere in this tool."
        >
          <Select
            value={config.costBasisMethod}
            onValueChange={(v) => setConfig({ costBasisMethod: v as typeof config.costBasisMethod })}
          >
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fifo">First in, first out</SelectItem>
              <SelectItem value="average">Average cost</SelectItem>
              <SelectItem value="hifo">Highest cost first</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {config.costBasisMethod === 'average'
              ? 'Required for Canadian taxable accounts. An averaged share has no individual holding period, so gains are not split into short and long term.'
              : config.costBasisMethod === 'hifo'
                ? 'Sells the most expensive shares first, which realises the smallest gain.'
                : 'The default in the absence of another election.'}
          </p>
        </Section>
        <Separator />

        {/* ---------------------------------------------------------- */}
        <Section
          title="Fees and costs"
          hint="Portfolio-level fees are charged in cash from the account. Fund expense ratios are set per holding in the builder and modelled as a daily reduction in value, the way a real fund charges them."
        >
          <div className="grid grid-cols-2 gap-2">
            <Field
              label="Management fee (%/yr)"
              htmlFor="cfg-mgmt"
              hint="An advisory or platform fee on the whole portfolio. Accrued daily, charged from cash at each month end."
            >
              <Input
                id="cfg-mgmt"
                type="number"
                min="0"
                max="20"
                step="0.05"
                value={config.fees.managementFeePct}
                onChange={(e) => setFees({ managementFeePct: Number(e.target.value) })}
                className="text-xs"
              />
            </Field>
            <Field
              label="Trading cost (bps)"
              htmlFor="cfg-bps"
              hint="Basis points of traded notional, covering spread and slippage. 10 bps is 0.10% of each trade."
            >
              <Input
                id="cfg-bps"
                type="number"
                min="0"
                max="1000"
                step="1"
                value={config.fees.tradingCostBps}
                onChange={(e) => setFees({ tradingCostBps: Number(e.target.value) })}
                className="text-xs"
              />
            </Field>
            <Field label="Commission per trade ($)" htmlFor="cfg-commission">
              <Input
                id="cfg-commission"
                type="number"
                min="0"
                step="0.5"
                value={config.fees.commissionPerTrade}
                onChange={(e) => setFees({ commissionPerTrade: Number(e.target.value) })}
                className="text-xs"
              />
            </Field>
            <Field
              label="Default expense ratio (%)"
              htmlFor="cfg-default-er"
              hint="Applied only to holdings that do not have their own expense ratio set in the builder."
            >
              <Input
                id="cfg-default-er"
                type="number"
                min="0"
                max="10"
                step="0.01"
                value={config.fees.defaultExpenseRatioPct}
                onChange={(e) => setFees({ defaultExpenseRatioPct: Number(e.target.value) })}
                className="text-xs"
              />
            </Field>
          </div>
        </Section>
        <Separator />

        {/* ---------------------------------------------------------- */}
        <Section
          title="Risk-free rate"
          hint="Used as the subtrahend in Sharpe and as the default minimum acceptable return in Sortino. Choosing the Treasury bill series pulls the actual 13-week bill rate for each day of the backtest."
        >
          <Select
            value={config.riskFree.source}
            onValueChange={(v) =>
              setConfig({
                riskFree: { ...config.riskFree, source: v as typeof config.riskFree.source },
              })
            }
          >
            <SelectTrigger className="text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="zero">Zero</SelectItem>
              <SelectItem value="constant">Fixed rate</SelectItem>
              <SelectItem value="tbill">13-week Treasury bill (^IRX)</SelectItem>
            </SelectContent>
          </Select>
          {config.riskFree.source === 'constant' && (
            <Field label="Rate (%/yr)" htmlFor="cfg-rf">
              <Input
                id="cfg-rf"
                type="number"
                min="0"
                max="25"
                step="0.25"
                value={config.riskFree.constantPct}
                onChange={(e) =>
                  setConfig({
                    riskFree: { ...config.riskFree, constantPct: Number(e.target.value) },
                  })
                }
                className="text-xs"
              />
            </Field>
          )}
        </Section>
        </AdvancedSettings>
      </CardContent>
    </Card>
  );
}
