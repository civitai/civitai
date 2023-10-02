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
  '/articles-sitemap.xml',
  '/models-sitemap.xml',
  '/questions-sitemap.xml',
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
        allow: '/',
        disallow,
      },
    ],
    additionalSitemaps: [
      `${process.env.NEXTAUTH_URL}/articles-sitemap.xml`,
      `${process.env.NEXTAUTH_URL}/models-sitemap.xml`,
      `${process.env.NEXTAUTH_URL}/questions-sitemap.xml`,
    ],
  },
}
