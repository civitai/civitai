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
  redirects: async () => {
    return [
      {
        source: '/api/download/training-data/:modelVersionId',
        destination: '/api/download/models/:modelVersionId?type=TrainingData',
        permanent: true,
      },
      {
        source: '/github',
        destination: 'https://github.com/civitai/civitai',
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
        source: '/ideas',
        destination: 'https://github.com/civitai/civitai/discussions/categories/ideas',
        permanent: true,
      },
    ];
  },
});
