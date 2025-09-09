/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverActions: true,
  },
  images: {
    domains: ['finnhub.io', 'api.polygon.io'],
  },
}

module.exports = nextConfig
