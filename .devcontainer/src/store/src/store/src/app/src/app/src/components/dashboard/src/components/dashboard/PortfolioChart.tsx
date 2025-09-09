'use client';

import { Card } from '@/components/ui/Card';
import { usePortfolioStore } from '@/store/portfolioStore';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

export default function PortfolioChart() {
  const { holdings, getTotalValue, getTotalCost } = usePortfolioStore();
  
  // Generate sample data for demonstration
  const data = [
    { name: 'Jan', value: 10000, cost: 10000 },
    { name: 'Feb', value: 10500, cost: 10000 },
    { name: 'Mar', value: 11200, cost: 10000 },
    { name: 'Apr', value: 10800, cost: 10000 },
    { name: 'May', value: 11500, cost: 10000 },
    { name: 'Jun', value: 12000, cost: 10000 },
  ];

  const totalValue = getTotalValue();
  const totalCost = getTotalCost();
  const totalGain = totalValue - totalCost;
  const gainPercent = totalCost > 0 ? (totalGain / totalCost) * 100 : 0;

  return (
    <Card className="p-6">
      <div className="mb-4">
        <h2 className="text-xl font-semibold">Portfolio Performance</h2>
        <div className="mt-2 space-y-1">
          <p className="text-2xl font-bold">${totalValue.toFixed(2)}</p>
          <p className={`text-sm ${totalGain >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {totalGain >= 0 ? '+' : ''}{totalGain.toFixed(2)} ({gainPercent.toFixed(2)}%)
          </p>
        </div>
      </div>
      
      <ResponsiveContainer width="100%" height={300}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip formatter={(value: any) => `$${value}`} />
          <Legend />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#3b82f6"
            strokeWidth={2}
            name="Portfolio Value"
          />
          <Line
            type="monotone"
            dataKey="cost"
            stroke="#94a3b8"
            strokeWidth={2}
            strokeDasharray="5 5"
            name="Total Cost"
          />
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}
