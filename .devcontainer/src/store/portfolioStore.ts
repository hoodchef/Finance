import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface Holding {
  symbol: string;
  quantity: number;
  avgPrice: number;
  currentPrice?: number;
}

interface PortfolioStore {
  holdings: Holding[];
  addHolding: (holding: Holding) => void;
  removeHolding: (symbol: string) => void;
  updateHolding: (symbol: string, updates: Partial<Holding>) => void;
  getTotalValue: () => number;
  getTotalCost: () => number;
}

export const usePortfolioStore = create<PortfolioStore>()(
  persist(
    (set, get) => ({
      holdings: [],
      
      addHolding: (holding) =>
        set((state) => ({
          holdings: [...state.holdings, holding],
        })),
      
      removeHolding: (symbol) =>
        set((state) => ({
          holdings: state.holdings.filter((h) => h.symbol !== symbol),
        })),
      
      updateHolding: (symbol, updates) =>
        set((state) => ({
          holdings: state.holdings.map((h) =>
            h.symbol === symbol ? { ...h, ...updates } : h
          ),
        })),
      
      getTotalValue: () => {
        const holdings = get().holdings;
        return holdings.reduce(
          (total, h) => total + (h.currentPrice || h.avgPrice) * h.quantity,
          0
        );
      },
      
      getTotalCost: () => {
        const holdings = get().holdings;
        return holdings.reduce(
          (total, h) => total + h.avgPrice * h.quantity,
          0
        );
      },
    }),
    {
      name: 'portfolio-storage',
    }
  )
);
