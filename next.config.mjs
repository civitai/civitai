// @ts-check

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
  images: {
    domains: [
      's3.us-west-1.wasabisys.com',
      'model-share.s3.us-west-1.wasabisys.com',
      'civitai-prod.s3.us-west-1.wasabisys.com',
      'civitai-dev.s3.us-west-1.wasabisys.com',
    ],
  },
  experimental: {
    // scrollRestoration: true,
    largePageDataBytes: 512 * 100000,
  },
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
      // TODO: Uncomment this after completing the new image detail page
      // {
      //   source: '/gallery/:path*',
      //   destination: '/images/:path*',
      //   permanent: true,
      // },
    ];
  },
  output: 'standalone',
});
