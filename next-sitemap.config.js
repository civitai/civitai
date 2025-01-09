const exclude = [
  '/*/create',
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
  '/user/stripe-connect/onboard',
  '/user/earn-potential',
  '/tipalti/*',
  '/research/*',
  '/claim/*',
  '/collections/youtube/auth',
  '/questions/*',
];

const allowedDomains = [
  process.env.NEXT_PUBLIC_SERVER_DOMAIN_BLUE,
  process.env.NEXT_PUBLIC_SERVER_DOMAIN_GREEN,
  process.env.NEXT_PUBLIC_SERVER_DOMAIN_RED,
].map((domain) => domain.includes('http') ? domain : 'https://' + domain);

const disallow = exclude.filter((path) => !path.includes('sitemap.xml'));
const isProdDomain = allowedDomains.includes(process.env.NEXT_PUBLIC_BASE_URL);

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
        disallow: isProdDomain ? disallow : '/',
        allow: isProdDomain ? ['/api/trpc/*'] : undefined,
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
