import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  transpilePackages: ['@civitai/db', '@civitai/db-schema'],
};
export default nextConfig;
