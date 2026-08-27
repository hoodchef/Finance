import { NextResponse } from 'next/server';
import { fetchCompanyFacts, resolveTicker } from '@/lib/fundamentals/sec';
import { buildAnnualRows, dilution, valuation } from '@/lib/fundamentals/metrics';
import { getProvider } from '@/lib/market-data';
import { MarketDataError } from '@/lib/market-data/provider';
import { errorResponse } from '@/lib/api-errors';
import { todayIso } from '@/lib/market-data/dates';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A company's reported fundamentals, with a current price for valuation.
 *
 * Two sources, kept distinct in the response because they have different
 * provenance and different staleness: the financials are XBRL facts from SEC
 * filings, and the price is whatever the market-data chain returns. A page
 * showing both under one "as of" date would misstate one of them.
 *
 * Price is optional. If the provider is rate-limited the financials still
 * render and the valuation section says why it is absent, rather than the whole
 * page failing over a quote.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const ticker = String(body.ticker ?? '').trim().toUpperCase().slice(0, 12);
    if (!ticker) {
      return NextResponse.json({ error: 'Enter a ticker.', kind: 'request' }, { status: 400 });
    }

    const company = await resolveTicker(ticker);
    const facts = await fetchCompanyFacts(company.cik);
    const { rows, conceptsUsed } = buildAnnualRows(facts);

    if (rows.length === 0) {
      throw new MarketDataError(
        `${company.name} files with the SEC, but no annual revenue figures could be read from ` +
          'its XBRL data. That happens with some funds, trusts and newly listed companies.',
        ticker,
      );
    }

    // Price is a best effort; the financials do not depend on it.
    let price: number | null = null;
    let priceAsOf: string | null = null;
    let priceNote: string | null = null;
    try {
      const end = todayIso();
      const start = new Date(Date.parse(end) - 30 * 86_400_000).toISOString().slice(0, 10);
      const series = await getProvider().getHistoricalPrices(ticker, { start, end });
      const lastBar = series.bars.at(-1);
      if (lastBar) {
        price = lastBar.close;
        priceAsOf = lastBar.date;
      }
    } catch (e) {
      priceNote =
        e instanceof MarketDataError
          ? 'A current price could not be fetched, so valuation ratios are unavailable.'
          : 'A current price could not be fetched.';
    }

    const val = price != null ? valuation(facts, rows, price) : null;
    const latestRow = rows[rows.length - 1];

    return NextResponse.json({
      company: {
        ticker: company.ticker,
        name: company.name,
        cik: company.cik,
      },
      rows,
      valuation: val,
      dilution: dilution(rows),
      price: price != null ? { close: price, asOf: priceAsOf } : null,
      priceNote,
      provenance: {
        financials: 'SEC EDGAR XBRL company facts, from the filings themselves',
        // The date of the most recent filing the figures came from, which is
        // what "current" means here — not today.
        latestFilingDate: latestRow.end,
        latestFiscalYear: latestRow.fiscalYear,
        priceSource: price != null ? getProvider().label : null,
        conceptsUsed,
        estimatesNote:
          'Analyst estimates and forward metrics are not shown. No free data source ' +
          'surveyed licenses them for display, and inventing a consensus would be worse ' +
          'than omitting one.',
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
