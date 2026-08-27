import { parseConfig, parsePositions, ValidationError } from '@/lib/validate';
import { defaultConfig } from '@/lib/defaults';
import { lookupSymbol, normaliseSymbol } from '@/lib/market-data/universe';
import { lookupCatalog } from '@/lib/market-data/catalog';
import type { BacktestConfig, Position } from '@/lib/types';
import type { RawProposal } from './ollama';

/**
 * Turns a model's answer into something the app will accept, or refuses.
 * =============================================================================
 * The boundary. Everything above this is untrusted text; everything below is a
 * validated request identical to one a person typed.
 *
 * A model's output is treated exactly like a shared link: hostile until parsed.
 * It goes through `parsePositions` and `parseConfig` — the same functions a
 * form submission uses — so a hallucinated allocation cannot reach the engine
 * by a route that a typed one could not.
 *
 * Symbols get one extra check the form does not need. A model will confidently
 * invent a plausible ticker, and an invented ticker fails much later, in a
 * provider error that reads like an outage. Checking each against the local
 * 13,000-symbol universe turns that into a flag on the review screen, before
 * anything runs.
 */

export interface InterpretedSymbol {
  symbol: string;
  weight: number;
  /** Name from the local universe, when it is a symbol we know. */
  name?: string;
  /**
   * True when the symbol is not in the local universe. Not fatal — the
   * universe is US listings plus a curated set, so a valid TSX ticker can be
   * absent — but it is the most likely place a model has invented something.
   */
  unrecognised: boolean;
}

export interface Interpretation {
  name: string;
  positions: Position[];
  symbols: InterpretedSymbol[];
  config: BacktestConfig;
  /** Fields the model left null, so the review screen can say what defaulted. */
  defaulted: string[];
  /** Whatever the model said it was unsure about. */
  notes: string;
  warnings: string[];
}

const REBALANCE = new Set(['never', 'monthly', 'quarterly', 'semiannual', 'annual']);

/** Model output is text; anything numeric has to survive being a string. */
function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[$,\s]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

export function interpretProposal(raw: RawProposal): Interpretation {
  const warnings: string[] = [];
  const defaulted: string[] = [];

  if (!Array.isArray(raw.positions) || raw.positions.length === 0) {
    throw new ValidationError(
      'The model did not return any holdings. Try naming the funds explicitly.',
      'positions',
    );
  }

  // Build candidate positions, then hand them to the real validator. Weights
  // are NOT normalised here: if the model produced something that does not sum
  // to 100, the user should see that rather than have it quietly corrected.
  const candidates = raw.positions.slice(0, 40).map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const symbol = String(row.symbol ?? row.ticker ?? '').trim().toUpperCase();
    return { symbol: symbol ? normaliseSymbol(symbol) : '', weight: num(row.weight) ?? 0 };
  });

  const positions = parsePositions(
    candidates.filter((c) => c.symbol).map((c) => ({ symbol: c.symbol, weight: c.weight })),
  );
  if (positions.length === 0) {
    throw new ValidationError('None of the returned holdings had a usable ticker.', 'positions');
  }

  const symbols: InterpretedSymbol[] = positions.map((p) => {
    const known = lookupSymbol(p.symbol) ?? lookupCatalog(p.symbol);
    return {
      symbol: p.symbol,
      weight: p.weight,
      name: known?.name,
      unrecognised: !known,
    };
  });

  const unknown = symbols.filter((s) => s.unrecognised).map((s) => s.symbol);
  if (unknown.length) {
    warnings.push(
      `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the local symbol list. ` +
        'That can be a valid listing it does not cover, or a ticker the model invented — check ' +
        'before running.',
    );
  }

  const total = positions.reduce((s, p) => s + p.weight, 0);
  if (Math.abs(total - 100) > 0.5) {
    warnings.push(`The weights total ${total.toFixed(1)}%, not 100%.`);
  }

  // Config: only fields the model actually supplied. A null means "not
  // mentioned", and the default is used and reported rather than invented.
  const base = defaultConfig();
  const start = isoDate(raw.start);
  const end = isoDate(raw.end);
  const initial = num(raw.initialInvestment);
  const rebalance =
    typeof raw.rebalance === 'string' && REBALANCE.has(raw.rebalance) ? raw.rebalance : null;

  if (!start) defaulted.push(`start date (${base.start})`);
  if (!end) defaulted.push(`end date (${base.end})`);
  if (initial == null) defaulted.push(`initial investment ($${base.initialInvestment})`);
  if (!rebalance) defaulted.push(`rebalancing (${base.rebalance})`);

  const config = parseConfig({
    ...base,
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
    ...(initial != null ? { initialInvestment: initial } : {}),
    ...(rebalance ? { rebalance } : {}),
  });

  const name = String(raw.name ?? '').trim().slice(0, 120) || 'From a description';
  const notes = String(raw.notes ?? '').trim().slice(0, 400);

  return { name, positions, symbols, config, defaulted, notes, warnings };
}
