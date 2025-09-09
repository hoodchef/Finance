import axios from 'axios';

const API_KEY = process.env.ALPHA_VANTAGE_API_KEY;
const BASE_URL = 'https://www.alphavantage.co/query';

export const alphaVantageAPI = {
  // Get real-time quote
  async getQuote(symbol: string) {
    try {
      const response = await axios.get(BASE_URL, {
        params: {
          function: 'GLOBAL_QUOTE',
          symbol,
          apikey: API_KEY,
        },
      });
      return response.data['Global Quote'];
    } catch (error) {
      console.error('Error fetching quote:', error);
      throw error;
    }
  },

  // Get daily time series
  async getDailyTimeSeries(symbol: string) {
    try {
      const response = await axios.get(BASE_URL, {
        params: {
          function: 'TIME_SERIES_DAILY',
          symbol,
          apikey: API_KEY,
        },
      });
      return response.data['Time Series (Daily)'];
    } catch (error) {
      console.error('Error fetching daily data:', error);
      throw error;
    }
  },

  // Search symbols
  async searchSymbols(keywords: string) {
    try {
      const response = await axios.get(BASE_URL, {
        params: {
          function: 'SYMBOL_SEARCH',
          keywords,
          apikey: API_KEY,
        },
      });
      return response.data.bestMatches;
    } catch (error) {
      console.error('Error searching symbols:', error);
      throw error;
    }
  },

  // Get company overview
  async getCompanyOverview(symbol: string) {
    try {
      const response = await axios.get(BASE_URL, {
        params: {
          function: 'OVERVIEW',
          symbol,
          apikey: API_KEY,
        },
      });
      return response.data;
    } catch (error) {
      console.error('Error fetching company overview:', error);
      throw error;
    }
  },
};
