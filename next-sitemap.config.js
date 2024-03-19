const exclude = [
  '/*/create',
  '/api/*',
  '/discord/*',
  '/dmca/*',
  '/intent/*',
  '/models/train',
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
];

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
        [process.env.NODE_ENV === 'prod' ? 'allow' : 'disallow']: '/',
        disallow,
        allow: ['/api/trpc/*']
      },
    ],
    additionalSitemaps: [
      // Add additional sitemaps here
      `${process.env.NEXTAUTH_URL}/sitemap-articles.xml`,
      `${process.env.NEXTAUTH_URL}/sitemap-models.xml`,
      `${process.env.NEXTAUTH_URL}/sitemap-questions.xml`,
    ],
  },
};
