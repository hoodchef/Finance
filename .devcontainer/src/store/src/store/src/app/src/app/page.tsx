import MarketOverview from '@/components/dashboard/MarketOverview';
import PortfolioChart from '@/components/dashboard/PortfolioChart';
import WatchlistCard from '@/components/dashboard/WatchlistCard';
import NewsSection from '@/components/dashboard/NewsSection';

export default function HomePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <MarketOverview />
        </div>
        <div>
          <WatchlistCard />
        </div>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <PortfolioChart />
        <NewsSection />
      </div>
    </div>
  );
}
