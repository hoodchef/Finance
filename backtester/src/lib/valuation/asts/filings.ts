/**
 * Is the model still standing on the latest filings?
 *
 * The capital structure is the 30-Jun-2026 10-Q pro forma one July offering,
 * and this is a company that raises convertibles every few months. A valuation
 * page that kept showing a per-share value after a new offering had changed the
 * share count and the debt stack would be precise and wrong. So the page asks
 * EDGAR what has been filed since the model's dates and says, in words, what
 * it means: a newer periodic report makes the balance sheet stale; an 8-K after
 * the valuation date may carry a financing the bridge does not include.
 *
 * It reports; it does not update. Folding a new filing into the model is a
 * judgement the analyst makes (and the break suite then re-tests), not
 * something a fetch should do behind the reader's back.
 */
import { MODEL_META } from './inputs';

export interface Filing {
  form: string;
  filed: string;
  period: string | null;
  description: string;
  url: string;
}

export type Freshness = 'current' | 'review' | 'stale';

export interface FilingStatus {
  freshness: Freshness;
  headline: string;
  latestPeriodic: Filing | null;
  sinceValuation: Filing[];
  checkedAt: string;
}

interface Submissions {
  filings: {
    recent: {
      accessionNumber: string[];
      filingDate: string[];
      reportDate: string[];
      form: string[];
      primaryDocument: string[];
      primaryDocDescription: string[];
    };
  };
}

const PERIODIC = new Set(['10-Q', '10-K', '10-Q/A', '10-K/A']);
/** Forms that can change the share count, the debt stack, or both. */
const CAPITAL = new Set(['8-K', '424B5', '424B7', 'S-3', 'S-3ASR', '8-K/A']);

export function assessFilings(sub: Submissions, now = new Date()): FilingStatus {
  const r = sub.filings.recent;
  const cik = MODEL_META.cik;
  const all: Filing[] = r.form.map((form, i) => ({
    form,
    filed: r.filingDate[i],
    period: r.reportDate[i] || null,
    description: r.primaryDocDescription[i] || form,
    url: `https://www.sec.gov/Archives/edgar/data/${cik}/${r.accessionNumber[i].replace(/-/g, '')}/${r.primaryDocument[i]}`,
  }));
  const latestPeriodic = all.find((f) => PERIODIC.has(f.form)) ?? null;
  const sinceValuation = all.filter(
    (f) => f.filed > MODEL_META.valuationDate && (PERIODIC.has(f.form) || CAPITAL.has(f.form)),
  );

  let freshness: Freshness = 'current';
  let headline = `No periodic report newer than the ${MODEL_META.balanceSheetDate} balance sheet, and nothing filed since the valuation date that could change the capital structure.`;
  if (latestPeriodic?.period && latestPeriodic.period > MODEL_META.balanceSheetDate) {
    freshness = 'stale';
    headline = `A ${latestPeriodic.form} for the period ending ${latestPeriodic.period} was filed on ${latestPeriodic.filed}. The model's balance sheet, share count and debt are as of ${MODEL_META.balanceSheetDate} and should be refreshed before the per-share value is relied on.`;
  } else if (sinceValuation.some((f) => CAPITAL.has(f.form))) {
    freshness = 'review';
    const n = sinceValuation.filter((f) => CAPITAL.has(f.form)).length;
    headline = `${n} filing${n === 1 ? '' : 's'} since the ${MODEL_META.valuationDate} valuation date could carry a financing — a new convertible, an at-the-market programme — that the equity bridge does not include. Read ${n === 1 ? 'it' : 'them'} before relying on the per-share value.`;
  }
  return { freshness, headline, latestPeriodic, sinceValuation, checkedAt: now.toISOString() };
}
