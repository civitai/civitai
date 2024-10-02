// @ts-check
import { withAxiom } from "next-axiom";
import packageJson from './package.json' assert { type: 'json' };

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

export default defineNextConfig(withAxiom({
  env: {
    version: packageJson.version,
  },
  reactStrictMode: true,
  productionBrowserSourceMaps: true,
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
      'image.civitai.com',
    ],
  },
  experimental: {
    // scrollRestoration: true,
    largePageDataBytes: 512 * 100000,

  },
  headers: async () => {
    // Add X-Robots-Tag header to all pages matching /sitemap.xml and /sitemap-models.xml /sitemap-articles.xml, etc
    const headers = [{
      source: '/sitemap(-\\w+)?.xml',
      headers: [
        { key: 'X-Robots-Tag', value: 'noindex' },
        { key: 'Content-Type', value: 'application/xml' },
        { key: 'Cache-Control', value: 'public, max-age=86400, must-revalidate' }
      ],
    }];

    if (process.env.NODE_ENV !== 'production') {
      headers.push({
        source: '/:path*',
        headers: [{
          key: 'X-Robots-Tag',
          value: 'noindex',
        }],
      });
    }

    headers.push({
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
      ],
    })

    return headers;
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
        destination: 'https://discord.gg/civitai',
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
        source: '/instagram',
        destination: 'https://www.instagram.com/hellocivitai/',
        permanent: true,
      },
      {
        source: '/tiktok',
        destination: 'https://www.tiktok.com/@hellocivitai',
        permanent: true,
      },
      {
        source: '/youtube',
        destination: 'https://www.youtube.com/@civitai',
        permanent: true,
      },
      {
        source: '/twitch',
        destination: 'https://www.twitch.tv/civitai',
        permanent: true,
      },
      {
        source: '/ideas',
        destination: 'https://github.com/civitai/civitai/discussions/categories/ideas',
        permanent: true,
      },
      {
        source: '/v/civitai-link-intro',
        destination: 'https://youtu.be/EHUjiDgh-MI',
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
      {
        source: '/canny/feedback',
        destination: 'https://feedback.civitai.com/?b=feature-request',
        permanent: true,
      },
      {
        source: '/feedback',
        destination: 'https://feedback.civitai.com/?b=feature-request',
        permanent: true,
      },
      {
        source: '/canny/bugs',
        destination: 'https://civitai-team.myfreshworks.com/login/auth/civitai?client_id=451979510707337272&redirect_uri=https%3A%2F%2Fcivitai.freshdesk.com%2Ffreshid%2Fcustomer_authorize_callback%3Fhd%3Dsupport.civitai.com',
        permanent: true,
      },
      {
        source: '/bugs',
        destination: 'https://civitai-team.myfreshworks.com/login/auth/civitai?client_id=451979510707337272&redirect_uri=https%3A%2F%2Fcivitai.freshdesk.com%2Ffreshid%2Fcustomer_authorize_callback%3Fhd%3Dsupport.civitai.com',
        permanent: true,
      },
      {
        source: '/support-portal',
        destination: 'https://civitai-team.myfreshworks.com/login/auth/civitai?client_id=451979510707337272&redirect_uri=https%3A%2F%2Fcivitai.freshdesk.com%2Ffreshid%2Fcustomer_authorize_callback%3Fhd%3Dsupport.civitai.com',
        permanent: true,
      },
      {
        source: '/leaderboard',
        destination: '/leaderboard/overall',
        permanent: true,
      },
      {
        source: '/forms/bounty-refund',
        destination: 'https://forms.clickup.com/8459928/f/825mr-8331/R30FGV9JFHLF527GGN',
        permanent: true,
      },
      {
        source: '/forms/press-inquiry',
        destination: 'https://forms.clickup.com/8459928/f/825mr-9351/RZXWRNLV9Q1D32ACNP',
        permanent: true,
      },
      {
        source: '/forms/matching-partner',
        destination: 'https://forms.clickup.com/8459928/f/825mr-9431/IQOAS1RXWHI1E2I1S3',
        permanent: true,
      },
      {
        source: '/holiday2023',
        destination: '/events/holiday2023',
        permanent: true,
      },
      {
        source: '/blocked-by-octoml',
        destination: '/articles/3307',
        permanent: true,
      },
      {
        source: '/blocked-by-provider',
        destination: '/articles/3307',
        permanent: true,
      },
      {
        source: '/wiki',
        destination: 'https://wiki.civitai.com',
        permanent: true,
      },
      {
        source: '/education',
        destination: 'https://education.civitai.com',
        permanent: true,
      },
      {
        source: '/advertise-with-us',
        destination: 'https://forms.clickup.com/8459928/f/825mr-10211/MIN35AIDXBZ7BTD5MG',
        permanent: true,
      },
      {
        source: '/ad-feedback',
        destination: 'https://forms.clickup.com/8459928/f/825mr-9711/WIMNO6V738T4ZBTPXP',
        permanent: true,
      },
      {
        source: '/cosmetic-shop',
        destination: '/shop',
        permanent: true,
      },
      {
        source: '/shop/cosmetic-shop',
        destination: '/shop',
        permanent: true,
      }
    ];
  },
  output: 'standalone',
}));
