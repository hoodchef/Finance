import type { BacktestConfig, Portfolio, Position } from '@/lib/types';
import { defaultConfig } from '@/lib/defaults';
import { uid } from '@/lib/utils';

/**
 * Shareable links.
 * =============================================================================
 * A backtest is only useful to someone else if they can reproduce it exactly,
 * so the link carries the full input: holdings, weights, dates, fees, every
 * rule. It does not carry results — the recipient's copy recomputes them, which
 * means a link can never show figures that disagree with the engine.
 *
 * Two constraints shaped the format:
 *
 *  1. **Short URLs.** Only values differing from the defaults are written, so a
 *     typical link is a couple of hundred characters rather than a wall of
 *     base64 encoding a config that is mostly defaults anyway.
 *  2. **Untrusted input.** Anything arriving from a URL is treated exactly like
 *     a request body: `decodeShareLink` returns a plain object and the caller
 *     runs it through the same validation the API uses. A link cannot inject a
 *     ticker, a weight or a fee that a typed request could not.
 */

const VERSION = 1;

/** Short keys keep the encoded payload small; the mapping is the format. */
const CONFIG_KEYS: Record<string, keyof BacktestConfig> = {
  s: 'start',
  e: 'end',
  i: 'initialInvestment',
  ca: 'contributionAmount',
  cf: 'contributionFrequency',
  cw: 'contributionIsWithdrawal',
  rb: 'rebalance',
  rt: 'rebalanceThresholdPct',
  dv: 'dividends',
  ip: 'inceptionPolicy',
  cy: 'cashYieldPct',
  cb: 'costBasisMethod',
  bm: 'benchmarks',
};

interface EncodedShape {
  v: number;
  n?: string;
  h: Array<[string, number] | [string, number, number]>;
  c?: Record<string, unknown>;
  f?: [number, number, number, number];
  rf?: [string, number];
  fl?: [string, number, boolean];
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = typeof btoa === 'function' ? btoa(binary) : Buffer.from(text).toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function encodeShareLink(
  portfolio: Pick<Portfolio, 'name' | 'positions'>,
  config: BacktestConfig,
): string {
  const d = defaultConfig();

  const holdings = portfolio.positions
    .filter((p) => p.symbol.trim())
    .map((p) =>
      p.expenseRatio != null
        ? ([p.symbol.trim().toUpperCase(), p.weight, p.expenseRatio] as [string, number, number])
        : ([p.symbol.trim().toUpperCase(), p.weight] as [string, number]),
    );

  const c: Record<string, unknown> = {};
  for (const [short, key] of Object.entries(CONFIG_KEYS)) {
    const value = config[key];
    const fallback = d[key];
    // Arrays need a value comparison; everything else is a primitive.
    const same = Array.isArray(value)
      ? JSON.stringify(value) === JSON.stringify(fallback)
      : value === fallback;
    if (!same) c[short] = value;
  }

  const shape: EncodedShape = { v: VERSION, h: holdings };
  if (portfolio.name && portfolio.name !== 'Untitled portfolio') shape.n = portfolio.name;
  if (Object.keys(c).length) shape.c = c;

  const f = config.fees;
  if (
    f.managementFeePct !== d.fees.managementFeePct ||
    f.tradingCostBps !== d.fees.tradingCostBps ||
    f.commissionPerTrade !== d.fees.commissionPerTrade ||
    f.defaultExpenseRatioPct !== d.fees.defaultExpenseRatioPct
  ) {
    shape.f = [
      f.managementFeePct,
      f.tradingCostBps,
      f.commissionPerTrade,
      f.defaultExpenseRatioPct,
    ];
  }

  if (
    config.riskFree.source !== d.riskFree.source ||
    config.riskFree.constantPct !== d.riskFree.constantPct
  ) {
    shape.rf = [config.riskFree.source, config.riskFree.constantPct];
  }

  if (
    config.inflation.mode !== d.inflation.mode ||
    config.inflation.constantPct !== d.inflation.constantPct ||
    config.inflation.adjustContributions !== d.inflation.adjustContributions
  ) {
    shape.fl = [
      config.inflation.mode,
      config.inflation.constantPct,
      config.inflation.adjustContributions,
    ];
  }

  return base64UrlEncode(JSON.stringify(shape));
}

export interface DecodedShare {
  /** Shaped for `parsePortfolio`; not yet validated. */
  portfolio: { id: string; name: string; positions: Position[] };
  /** Shaped for `parseConfig`; not yet validated. */
  config: Record<string, unknown>;
}

/**
 * Decodes a link into raw objects. Deliberately does **not** validate — the
 * caller passes the result through `parsePortfolio` / `parseConfig`, the same
 * gate a typed request goes through, so there is exactly one place where input
 * rules live.
 */
export function decodeShareLink(encoded: string): DecodedShare | null {
  try {
    const shape = JSON.parse(base64UrlDecode(encoded)) as EncodedShape;
    if (!shape || typeof shape !== 'object') return null;
    if (shape.v !== VERSION) return null;
    if (!Array.isArray(shape.h) || shape.h.length === 0) return null;

    const positions: Position[] = shape.h
      .filter((h) => Array.isArray(h) && typeof h[0] === 'string')
      .map((h) => ({
        id: uid('pos'),
        symbol: String(h[0]).toUpperCase(),
        weight: Number(h[1]) || 0,
        expenseRatio: h.length > 2 ? Number(h[2]) : undefined,
      }));

    if (!positions.length) return null;

    const config: Record<string, unknown> = {};
    for (const [short, key] of Object.entries(CONFIG_KEYS)) {
      if (shape.c && short in shape.c) config[key] = shape.c[short];
    }
    if (Array.isArray(shape.f) && shape.f.length === 4) {
      config.fees = {
        managementFeePct: shape.f[0],
        tradingCostBps: shape.f[1],
        commissionPerTrade: shape.f[2],
        defaultExpenseRatioPct: shape.f[3],
      };
    }
    if (Array.isArray(shape.rf) && shape.rf.length === 2) {
      config.riskFree = { source: shape.rf[0], constantPct: shape.rf[1] };
    }
    if (Array.isArray(shape.fl) && shape.fl.length === 3) {
      config.inflation = {
        mode: shape.fl[0],
        constantPct: shape.fl[1],
        adjustContributions: shape.fl[2],
      };
    }

    return {
      portfolio: {
        id: uid('pf'),
        name: typeof shape.n === 'string' ? shape.n.slice(0, 120) : 'Shared portfolio',
        positions,
      },
      config,
    };
  } catch {
    return null;
  }
}

export function buildShareUrl(
  origin: string,
  portfolio: Pick<Portfolio, 'name' | 'positions'>,
  config: BacktestConfig,
): string {
  return `${origin}/backtest?s=${encodeShareLink(portfolio, config)}`;
}
