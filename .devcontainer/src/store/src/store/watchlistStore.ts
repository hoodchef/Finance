import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface WatchlistItem {
  symbol: string;
  name: string;
  price?: number;
  change?: number;
  changePercent?: number;
}

interface WatchlistStore {
  items: WatchlistItem[];
  addItem: (item: WatchlistItem) => void;
  removeItem: (symbol: string) => void;
  updateItem: (symbol: string, updates: Partial<WatchlistItem>) => void;
  clearWatchlist: () => void;
}

export const useWatchlistStore = create<WatchlistStore>()(
  persist(
    (set) => ({
      items: [],
      
      addItem: (item) =>
        set((state) => ({
          items: [...state.items, item],
        })),
      
      removeItem: (symbol) =>
        set((state) => ({
          items: state.items.filter((item) => item.symbol !== symbol),
        })),
      
      updateItem: (symbol, updates) =>
        set((state) => ({
          items: state.items.map((item) =>
            item.symbol === symbol ? { ...item, ...updates } : item
          ),
        })),
      
      clearWatchlist: () => set({ items: [] }),
    }),
    {
      name: 'watchlist-storage',
    }
  )
);
