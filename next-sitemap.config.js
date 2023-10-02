const exclude = [
  '/*/create',
  '/api/*',
  '/discord/*',
  '/dmca/*',
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
  // Add additional sitemaps here to be excluded from indexing
  '/sitemap-articles.xml',
  '/sitemap-models.xml',
  '/sitemap-questions.xml',
]

const disallow = exclude.filter((path) => !path.includes('sitemap.xml'))

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
      },
    ],
    additionalSitemaps: [
      // Add additional sitemaps here
      `${process.env.NEXTAUTH_URL}/sitemap-articles.xml`,
      `${process.env.NEXTAUTH_URL}/sitemap-models.xml`,
      `${process.env.NEXTAUTH_URL}/sitemap-questions.xml`,
    ],
  },
}
