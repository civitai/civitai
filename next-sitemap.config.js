const exclude = [
  '/*/create',
  '/**/*/edit',
  '/api/*',
  '/discord/*',
  '/dmca/*',
  '/intent/*',
  '/models/train',
  '/models/*/wizard',
  '/models/*/model-versions/*/wizard',
  '/moderator/*',
  '/payment/*',
  '/redirect',
  '/search/*',
  '/testing/*',
  '/user/account',
  '/user/downloads',
  '/user/notifications',
  '/user/transactions',
  '/user/buzz-dashboard',
  '/user/vault',
  '/user/membership',
  '/user/stipe-connect/onboard',
  '/user/earn-potential',
  '/tipalti/*',
  '/research/*',
  '/claim/*',
];

const allowedDomains = [
  process.env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE,
  process.env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN,
  process.env.NEXT_PUBLIC_SERVER_DOMAIN_RED,
]

const disallow = exclude.filter((path) => !path.includes('sitemap.xml'));

/** @type {import('next-sitemap').IConfig} */
module.exports = {
  siteUrl: process.env.NEXTAUTH_URL || 'http://localhost:3000',
  generateRobotsTxt: true,
  sitemapSize: 5000,
  changefreq: null,
  priority: null,
  exclude,
  robotsTxtOptions: {
    policies: [
      {
        userAgent: '*',
        [process.env.NODE_ENV === 'prod' && allowedDomains.includes(process.env.NEXT_PUBLIC_BASE_URL) ? 'allow' : 'disallow']: '/',
        disallow,
        allow: ['/api/trpc/*']
      },
    ],
    additionalSitemaps: [
      // Add additional sitemaps here
      `${process.env.NEXTAUTH_URL}/sitemap-articles.xml`,
      `${process.env.NEXTAUTH_URL}/sitemap-models.xml`,
      `${process.env.NEXTAUTH_URL}/sitemap-tools.xml`,
    ],
  },
};
