'use client';

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { TrendingUp, TrendingDown } from 'lucide-react';

const INDICES = [
  { symbol: 'SPX', name: 'S&P 500' },
  { symbol: 'DJI', name: 'Dow Jones' },
  { symbol: 'IXIC', name: 'NASDAQ' },
  { symbol: 'RUT', name: 'Russell 2000' },
];

export default function MarketOverview() {
  const [marketData, setMarketData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchMarketData();
  }, []);

  const fetchMarketData = async () => {
    try {
      // Fetch data for each index
      const promises = INDICES.map(async (index) => {
        const response = await fetch(`/api/stocks?symbol=${index.symbol}`);
        const data = await response.json();
        return { ...index, ...data };
      });
      
      const results = await Promise.all(promises);
      setMarketData(results);
    } catch (error) {
      console.error('Error fetching market data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-6">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-12 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <h2 className="text-xl font-semibold mb-4">Market Overview</h2>
      <div className="space-y-3">
        {marketData.map((index) => (
          <div
            key={index.symbol}
            className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
          >
            <div>
              <p className="font-medium">{index.name}</p>
              <p className="text-sm text-gray-600">{index.symbol}</p>
            </div>
            <div className="text-right">
              <p className="font-semibold">${index.price?.toFixed(2)}</p>
              <div
                className={`flex items-center gap-1 ${
                  index.change >= 0 ? 'text-green-600' : 'text-red-600'
                }`}
              >
                {index.change >= 0 ? (
                  <TrendingUp className="w-4 h-4" />
                ) : (
                  <TrendingDown className="w-4 h-4" />
                )}
                <span className="text-sm">
                  {index.changePercent?.toFixed(2)}%
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
