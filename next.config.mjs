// @ts-check
import { withPlausibleProxy } from 'next-plausible';

/**
 * Don't be scared of the generics here.
 * All they do is to give us autocompletion when using this.
 *
 * @template {import('next').NextConfig} T
 * @param {T} config - A generic parameter that flows through to the return type
 * @constraint {{import('next').NextConfig}}
 */
function defineNextConfig(config) {
  return config;
}

export default defineNextConfig({
  reactStrictMode: true,
  // Next.js i18n docs: https://nextjs.org/docs/advanced-features/i18n-routing
  i18n: {
    locales: ['en'],
    defaultLocale: 'en',
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  generateEtags: false,
  compress: false,
  images: {
    domains: [
      's3.us-west-1.wasabisys.com',
      'model-share.s3.us-west-1.wasabisys.com',
      'civitai-prod.s3.us-west-1.wasabisys.com',
      'civitai-dev.s3.us-west-1.wasabisys.com',
      'explorer-api.walletconnect.com'
    ],
  },
  experimental: {
    // scrollRestoration: true,
    largePageDataBytes: 512 * 100000,
    modularizeImports: {
      'lodash': {
        transform: 'lodash/{{member}}',
        preventFullImport: true
      }
    }
  },
  poweredByHeader: false,
  redirects: async () => {
    return [
      {
        source: '/api/download/training-data/:modelVersionId',
        destination: '/api/download/models/:modelVersionId?type=Training%20Data',
        permanent: true,
      },
      {
        source: '/github/:path*',
        destination: 'https://github.com/civitai/civitai/:path*',
        permanent: true,
      },
      {
        source: '/discord',
        destination: 'https://discord.gg/UwX5wKwm6c',
        permanent: true,
      },
      {
        source: '/twitter',
        destination: 'https://twitter.com/HelloCivitai',
        permanent: true,
      },
      {
        source: '/reddit',
        destination: 'https://reddit.com/r/civitai',
        permanent: true,
      },
      {
        source: '/ideas',
        destination: 'https://github.com/civitai/civitai/discussions/categories/ideas',
        permanent: true,
      },
      {
        source: '/v/civitai-link-intro',
        destination: 'https://youtu.be/MaSRXvM05x4',
        permanent: false,
      },
      {
        source: '/v/civitai-link-installation',
        destination: 'https://youtu.be/fs-Zs-fvxb0',
        permanent: false,
      },
      {
        source: '/gallery/:path*',
        destination: '/images/:path*',
        permanent: true,
      },
      {
        source: '/appeal',
        destination: 'https://forms.clickup.com/8459928/f/825mr-5844/5NXSA2EIT3YOS2JSF7',
        permanent: true,
      },
    ];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // don't resolve node.js module on the client
      // to prevent this error on build
      // Error: Can't resolve '<node.js internal modules>'
      config.resolve.fallback = {
        fs: false,
        net: false,
        tls: false,
      }
    }
    return config;
  },
  output: 'standalone',
});
