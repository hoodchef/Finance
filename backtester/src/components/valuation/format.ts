import type { Unit } from '@/lib/valuation/asts/inputs';

const MINUS = '−';
const finite = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** $ per share. */
export function usd(v: number | null | undefined, digits = 2): string {
  if (!finite(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${v < 0 ? MINUS : ''}$${s}`;
}

/** $ millions, compacted to billions from $1,000mm. The model's native unit. */
export function mm(v: number | null | undefined, digits?: number): string {
  if (!finite(v)) return '—';
  const a = Math.abs(v);
  const s =
    a >= 1000
      ? `$${(a / 1000).toLocaleString('en-US', { minimumFractionDigits: digits ?? 2, maximumFractionDigits: digits ?? 2 })}bn`
      : `$${a.toLocaleString('en-US', { minimumFractionDigits: digits ?? 0, maximumFractionDigits: digits ?? 0 })}mm`;
  return `${v < 0 ? MINUS : ''}${s}`;
}

/** $ millions at full precision — for bridges and reconciliations, where $3.8bn cannot be tied to a filing. */
export function mmFull(v: number | null | undefined, digits = 1): string {
  if (!finite(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${v < 0 ? MINUS : ''}$${s}mm`;
}

/** Plain $mm with a thousands separator, for dense statement tables. Negatives in parentheses, as the workbook. */
export function mmCell(v: number | null | undefined, digits = 1): string {
  if (!finite(v)) return '—';
  if (Math.abs(v) < 0.05 && digits <= 1) return '–';
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return v < 0 ? `(${s})` : s;
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (!finite(v)) return '—';
  return `${v < 0 ? MINUS : ''}${Math.abs(v * 100).toFixed(digits)}%`;
}

export function signedPct(v: number | null | undefined, digits = 1): string {
  if (!finite(v)) return '—';
  return `${v > 0 ? '+' : v < 0 ? MINUS : ''}${Math.abs(v * 100).toFixed(digits)}%`;
}

export function mult(v: number | null | undefined, digits = 1): string {
  if (!finite(v)) return 'n/m';
  return `${v.toFixed(digits)}×`;
}

export function num(v: number | null | undefined, digits = 2): string {
  if (!finite(v)) return '—';
  return `${v < 0 ? MINUS : ''}${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** An input value in its display unit — percent rows show 4.84, not 0.0484. */
export function toDisplay(v: number, unit: Unit): number {
  return unit === '%' ? v * 100 : v;
}
export function fromDisplay(v: number, unit: Unit): number {
  return unit === '%' ? v / 100 : v;
}

export function unitValue(v: number, unit: Unit): string {
  switch (unit) {
    case '%': return pct(v, 2);
    case '$mm': return mm(v, Math.abs(v) < 100 ? 1 : 0);
    case '$mm/yr': return `${mm(v, 1)}/yr`;
    case '$/mo': return `${usd(v)}/mo`;
    case 'mm': return `${num(v, 0)}mm`;
    case 'x': return num(v, 2);
    case 'yr': case 'flag': case '#': return String(v);
    case 'yrs': return `${num(v, v % 1 ? 1 : 0)} yrs`;
  }
}
