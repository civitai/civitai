// @ts-check
const Adapter = require('@next-boost/redis-cache').Adapter

/** @type {import('@next-boost/next-boost/dist/types').HandlerConfig} */
module.exports = {
  rules: [
    {
      regex: '^/blog.*',
      ttl: 300,
    },
    {
      regex: '.*',
      ttl: 10,
    },
  ],
  paramFilter: p => {
    p === 'fbclid' || p.startsWith('utm_') ? false : true
  },
  cacheAdapter: new Adapter({
    uri: 'redis://127.0.0.1:6379/',
    ttl: 60,
    tbd: 3600,
  }),
}