/**
 * @type {import('next').NextConfig}
 *
 * `logging.fetches.fullUrl: false` is a security control, not a preference:
 * provider URLs carry API keys in query strings, and Next logs outbound fetches
 * in development. Turning full URLs on would print live keys to the console and
 * into any captured terminal output.
 */

/**
 * Defence-in-depth headers.
 *
 * The app renders financial figures and takes no third-party embeds, so the
 * policy can be strict. `unsafe-inline`/`unsafe-eval` are required by Next's
 * development runtime; production keeps inline styles (Tailwind and Recharts
 * both set them) but drops eval.
 */
const isDev = process.env.NODE_ENV !== 'production';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // Market data is fetched server-side; the browser never calls a provider
  // directly, so it needs no outbound origins of its own.
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  // The app is local-first today; the header is harmless over http and correct
  // the moment it is served over TLS.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

const nextConfig = {
  reactStrictMode: true,
  logging: { fetches: { fullUrl: false } },
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

module.exports = nextConfig;
