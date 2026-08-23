import type { AssetClass } from '@/lib/types';

/**
 * A small offline catalogue so ticker autocomplete responds instantly and still
 * works when the search endpoint is unreachable. Symbols and fund names only —
 * no expense ratios, no returns, no yields. Anything numeric has to come from
 * the data provider or from the user, never from a hard-coded table that can
 * silently go stale.
 */
export interface CatalogEntry {
  symbol: string;
  name: string;
  assetClass: AssetClass;
}

export const CATALOG: CatalogEntry[] = [
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', assetClass: 'etf' },
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', assetClass: 'etf' },
  { symbol: 'IVV', name: 'iShares Core S&P 500 ETF', assetClass: 'etf' },
  { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', assetClass: 'etf' },
  { symbol: 'ITOT', name: 'iShares Core S&P Total U.S. Stock Market ETF', assetClass: 'etf' },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', assetClass: 'etf' },
  { symbol: 'QQQM', name: 'Invesco NASDAQ 100 ETF', assetClass: 'etf' },
  { symbol: 'DIA', name: 'SPDR Dow Jones Industrial Average ETF Trust', assetClass: 'etf' },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF', assetClass: 'etf' },
  { symbol: 'VB', name: 'Vanguard Small-Cap ETF', assetClass: 'etf' },
  { symbol: 'VO', name: 'Vanguard Mid-Cap ETF', assetClass: 'etf' },
  { symbol: 'VTV', name: 'Vanguard Value ETF', assetClass: 'etf' },
  { symbol: 'VUG', name: 'Vanguard Growth ETF', assetClass: 'etf' },
  { symbol: 'SCHD', name: 'Schwab U.S. Dividend Equity ETF', assetClass: 'etf' },
  { symbol: 'VYM', name: 'Vanguard High Dividend Yield ETF', assetClass: 'etf' },
  { symbol: 'VXUS', name: 'Vanguard Total International Stock ETF', assetClass: 'etf' },
  { symbol: 'VEA', name: 'Vanguard FTSE Developed Markets ETF', assetClass: 'etf' },
  { symbol: 'VWO', name: 'Vanguard FTSE Emerging Markets ETF', assetClass: 'etf' },
  { symbol: 'EFA', name: 'iShares MSCI EAFE ETF', assetClass: 'etf' },
  { symbol: 'VT', name: 'Vanguard Total World Stock ETF', assetClass: 'etf' },
  { symbol: 'BND', name: 'Vanguard Total Bond Market ETF', assetClass: 'etf' },
  { symbol: 'AGG', name: 'iShares Core U.S. Aggregate Bond ETF', assetClass: 'etf' },
  { symbol: 'BNDX', name: 'Vanguard Total International Bond ETF', assetClass: 'etf' },
  { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', assetClass: 'etf' },
  { symbol: 'IEF', name: 'iShares 7-10 Year Treasury Bond ETF', assetClass: 'etf' },
  { symbol: 'SHY', name: 'iShares 1-3 Year Treasury Bond ETF', assetClass: 'etf' },
  { symbol: 'TIP', name: 'iShares TIPS Bond ETF', assetClass: 'etf' },
  { symbol: 'LQD', name: 'iShares iBoxx $ Investment Grade Corporate Bond ETF', assetClass: 'etf' },
  { symbol: 'HYG', name: 'iShares iBoxx $ High Yield Corporate Bond ETF', assetClass: 'etf' },
  { symbol: 'GLD', name: 'SPDR Gold Shares', assetClass: 'etf' },
  { symbol: 'IAU', name: 'iShares Gold Trust', assetClass: 'etf' },
  { symbol: 'SLV', name: 'iShares Silver Trust', assetClass: 'etf' },
  { symbol: 'VNQ', name: 'Vanguard Real Estate ETF', assetClass: 'etf' },
  { symbol: 'DBC', name: 'Invesco DB Commodity Index Tracking Fund', assetClass: 'etf' },
  { symbol: 'TQQQ', name: 'ProShares UltraPro QQQ', assetClass: 'etf' },
  { symbol: 'UPRO', name: 'ProShares UltraPro S&P 500', assetClass: 'etf' },
  { symbol: 'SSO', name: 'ProShares Ultra S&P 500', assetClass: 'etf' },
  { symbol: 'XEQT.TO', name: 'iShares Core Equity ETF Portfolio', assetClass: 'etf' },
  { symbol: 'VGRO.TO', name: 'Vanguard Growth ETF Portfolio', assetClass: 'etf' },
  { symbol: 'VFV.TO', name: 'Vanguard S&P 500 Index ETF (CAD)', assetClass: 'etf' },
  { symbol: 'ZSP.TO', name: 'BMO S&P 500 Index ETF', assetClass: 'etf' },
  { symbol: '^GSPC', name: 'S&P 500 Index', assetClass: 'index' },
  { symbol: '^NDX', name: 'NASDAQ-100 Index', assetClass: 'index' },
  { symbol: '^DJI', name: 'Dow Jones Industrial Average', assetClass: 'index' },
  { symbol: '^RUT', name: 'Russell 2000 Index', assetClass: 'index' },
  { symbol: '^IRX', name: '13-Week U.S. Treasury Bill', assetClass: 'index' },
  { symbol: '^VIX', name: 'CBOE Volatility Index', assetClass: 'index' },
  { symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'equity' },
  { symbol: 'MSFT', name: 'Microsoft Corporation', assetClass: 'equity' },
  { symbol: 'GOOGL', name: 'Alphabet Inc. Class A', assetClass: 'equity' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', assetClass: 'equity' },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', assetClass: 'equity' },
  { symbol: 'META', name: 'Meta Platforms Inc.', assetClass: 'equity' },
  { symbol: 'TSLA', name: 'Tesla Inc.', assetClass: 'equity' },
  { symbol: 'BRK-B', name: 'Berkshire Hathaway Inc. Class B', assetClass: 'equity' },
  { symbol: 'JPM', name: 'JPMorgan Chase & Co.', assetClass: 'equity' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', assetClass: 'equity' },
  { symbol: 'KO', name: 'The Coca-Cola Company', assetClass: 'equity' },
  { symbol: 'PG', name: 'Procter & Gamble Company', assetClass: 'equity' },
  { symbol: 'XOM', name: 'Exxon Mobil Corporation', assetClass: 'equity' },
  { symbol: 'COST', name: 'Costco Wholesale Corporation', assetClass: 'equity' },
  { symbol: 'BTC-USD', name: 'Bitcoin USD', assetClass: 'crypto' },
  { symbol: 'ETH-USD', name: 'Ethereum USD', assetClass: 'crypto' },
  { symbol: 'CASH', name: 'Cash / money market sleeve', assetClass: 'cash' },
];

const bySymbol = new Map(CATALOG.map((e) => [e.symbol.toUpperCase(), e]));

export function lookupCatalog(symbol: string): CatalogEntry | undefined {
  return bySymbol.get(symbol.toUpperCase());
}

export function searchCatalog(query: string, limit = 8): CatalogEntry[] {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const starts: CatalogEntry[] = [];
  const contains: CatalogEntry[] = [];
  for (const entry of CATALOG) {
    const sym = entry.symbol.toUpperCase();
    if (sym.startsWith(q)) starts.push(entry);
    else if (sym.includes(q) || entry.name.toUpperCase().includes(q)) contains.push(entry);
  }
  return [...starts, ...contains].slice(0, limit);
}
