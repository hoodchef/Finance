/** Display formatting. Every number the UI shows goes through one of these. */

const currencyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const currencyFmtCents = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatCurrency(v: number | null | undefined, cents = false): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  // A residual of -1e-12 formats as "-$0.00", which in a reconciliation panel
  // reads as a real discrepancy too small to show rather than as agreement.
  // Anything that rounds to zero IS zero at display precision.
  const rounded = abs < (cents || abs < 1000 ? 0.005 : 0.5) ? 0 : v;
  if (!cents && abs >= 1000) return currencyFmt.format(rounded);
  return currencyFmtCents.format(rounded);
}

/** Compact form for axis labels: $1.8M, $284K. */
export function formatCurrencyCompact(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  // Same reasoning as formatCurrency: no "-$0".
  const sign = v < 0 && abs >= 0.5 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/** `0.148` → `14.8%`. */
export function formatPercent(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function formatSignedPercent(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const s = (v * 100).toFixed(digits);
  return `${v > 0 ? '+' : ''}${s}%`;
}

export function formatNumber(v: number | null | undefined, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

export function formatShares(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

export function formatDate(iso: string): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[Number(m) - 1]} ${y}`;
}

export function formatDateShort(iso: string): string {
  if (!iso) return '—';
  const [y, m] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1]} ${y}`;
}

export function formatDuration(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return '—';
  if (days < 45) return `${Math.round(days)}d`;
  const months = days / 30.44;
  if (months < 24) return `${months.toFixed(months < 10 ? 1 : 0)}mo`;
  return `${(days / 365.25).toFixed(1)}y`;
}

export const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];
