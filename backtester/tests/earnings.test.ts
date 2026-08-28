import { describe, expect, it } from 'vitest';
import { parseCalendarCsv } from '../src/lib/earnings/calendar';
import { earningsHistory } from '../src/lib/earnings/history';
import type { CompanyFacts } from '../src/lib/fundamentals/sec';
import type { Filing } from '../src/lib/news/filings';

/**
 * Earnings, against the shapes the sources actually return.
 * =============================================================================
 * Fixtures trimmed from Alpha Vantage's EARNINGS_CALENDAR and Apple's EDGAR
 * company facts, recorded 2026-08-27.
 */

const filing = (filed: string, events: string[], form = '8-K'): Filing => ({
  form,
  formLabel: 'Current report',
  filed,
  reportDate: null,
  events,
  notable: false,
  url: `https://sec.gov/${filed}`,
  accession: filed,
});

const quarterFacts = (
  points: Array<{ start: string; end: string; eps?: number; rev?: number; filed: string; fp?: string }>,
): CompanyFacts =>
  ({
    cik: 320193,
    entityName: 'Apple Inc.',
    facts: {
      'us-gaap': {
        EarningsPerShareDiluted: {
          units: {
            'USD/shares': points
              .filter((p) => p.eps !== undefined)
              .map((p) => ({
                start: p.start, end: p.end, val: p.eps!, form: '10-Q', fp: p.fp ?? 'Q3', filed: p.filed,
              })),
          },
        },
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: {
            USD: points
              .filter((p) => p.rev !== undefined)
              .map((p) => ({
                start: p.start, end: p.end, val: p.rev!, form: '10-Q', fp: p.fp ?? 'Q3', filed: p.filed,
              })),
          },
        },
      },
    },
  }) as unknown as CompanyFacts;

describe('the earnings calendar CSV', () => {
  it('keeps columns aligned when a company name contains a comma', () => {
    // "ALARUM TECHNOLOGIES, LTD." split on every comma shifts every later
    // column, which silently turns the date column into part of the name.
    const rows = parseCalendarCsv(
      'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n' +
        'ALAR,"ALARUM TECHNOLOGIES, LTD.",2026-08-27,2026-06-30,,USD,post-market\n',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('ALARUM TECHNOLOGIES, LTD.');
    expect(rows[0].reportDate).toBe('2026-08-27');
    expect(rows[0].timeOfDay).toBe('post-market');
  });

  it('drops a row whose report date is not a date', () => {
    // A malformed row is not a company reporting today.
    const rows = parseCalendarCsv(
      'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n' +
        'GOOD,Good Co,2026-10-29,2026-09-30,,USD,\n' +
        'BAD,Bad Co,,2026-09-30,,USD,\n' +
        'UGLY,Ugly Co,not-a-date,2026-09-30,,USD,\n',
    );
    expect(rows.map((r) => r.symbol)).toEqual(['GOOD']);
  });

  it('does not carry the consensus estimate into the parsed rows', () => {
    // The page states no free source licenses analyst estimates for display.
    const rows = parseCalendarCsv(
      'symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n' +
        'ADSK,AUTODESK,2026-08-27,2026-07-31,2.35,USD,post-market\n',
    );
    expect(JSON.stringify(rows)).not.toContain('2.35');
  });

  it('returns nothing for a header with no rows', () => {
    expect(parseCalendarCsv('symbol,name,reportDate\n')).toEqual([]);
    expect(parseCalendarCsv('')).toEqual([]);
  });
});

describe('past earnings', () => {
  const points = [
    { start: '2025-12-28', end: '2026-03-28', eps: 2.01, rev: 111_184_000_000, filed: '2026-05-01', fp: 'Q2' },
    { start: '2026-03-29', end: '2026-06-27', eps: 2.02, rev: 109_417_000_000, filed: '2026-07-31', fp: 'Q3' },
  ];

  it('dates a quarter by the 8-K that announced it, not the 10-Q', () => {
    // The earnings release is the 8-K carrying item 2.02. The 10-Q follows
    // weeks later and would date the quarter wrongly.
    const out = earningsHistory(quarterFacts(points), [
      filing('2026-07-30', ['Reported results of operations', 'Financial statements and exhibits']),
      filing('2026-04-30', ['Reported results of operations']),
      filing('2026-07-31', [], '10-Q'),
    ]);
    const q3 = out.find((q) => q.end === '2026-06-27')!;
    expect(q3.reportedOn).toBe('2026-07-30');
    expect(q3.epsDiluted).toBe(2.02);
    expect(q3.revenue).toBe(109_417_000_000);
  });

  it('ignores an 8-K filed before the quarter ended', () => {
    const out = earningsHistory(quarterFacts(points), [
      filing('2026-01-29', ['Reported results of operations']),
    ]);
    expect(out.find((q) => q.end === '2026-06-27')!.reportedOn).toBeNull();
  });

  it('does not attach a release filed months later to an older quarter', () => {
    // Beyond four months the next 2.02 belongs to a following quarter.
    const out = earningsHistory(quarterFacts([points[0]]), [
      filing('2026-11-01', ['Reported results of operations']),
    ]);
    expect(out[0].reportedOn).toBeNull();
  });

  it('orders newest first', () => {
    const out = earningsHistory(quarterFacts(points), []);
    expect(out.map((q) => q.end)).toEqual(['2026-06-27', '2026-03-28']);
  });

  it('includes a quarter with revenue but no tagged EPS', () => {
    const out = earningsHistory(
      quarterFacts([{ start: '2026-03-29', end: '2026-06-27', rev: 109_417_000_000, filed: '2026-07-31' }]),
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0].epsDiluted).toBeNull();
    expect(out[0].revenue).toBe(109_417_000_000);
  });

  it('ignores an annual period offered alongside the quarters', () => {
    // Only ~13-week durations are quarters; a full year in the same concept
    // would otherwise land in the table as one enormous quarter.
    const out = earningsHistory(
      quarterFacts([
        { start: '2025-09-28', end: '2026-09-26', eps: 7.8, rev: 430_000_000_000, filed: '2026-10-30' },
        ...points,
      ]),
      [],
    );
    expect(out.map((q) => q.end)).toEqual(['2026-06-27', '2026-03-28']);
  });

  it('takes the latest filing when a quarter is restated', () => {
    const out = earningsHistory(
      quarterFacts([
        { start: '2026-03-29', end: '2026-06-27', eps: 2.02, rev: 109_417_000_000, filed: '2026-07-31' },
        { start: '2026-03-29', end: '2026-06-27', eps: 1.98, rev: 109_000_000_000, filed: '2026-10-30' },
      ]),
      [],
    );
    expect(out[0].epsDiluted).toBe(1.98);
  });
});
