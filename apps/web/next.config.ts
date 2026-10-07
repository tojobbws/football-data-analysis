import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // shared TS source (labels, settlement wording) — one definition for workers and web
  transpilePackages: ['@fp/analysis'],
  images: { remotePatterns: [{ protocol: 'https', hostname: 'media.api-sports.io' }] },
  webpack(config) {
    // workspace packages are ESM TS that import siblings as './x.js'
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};

export default nextConfig;

// lets `next dev` read Cloudflare bindings/env the same way the deployed worker does
initOpenNextCloudflareForDev();
