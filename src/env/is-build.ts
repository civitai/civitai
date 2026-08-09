// Split out of `~/env/server` so modules needing only this flag don't pull the
// 958-line server env schema into their import graph — `_app`'s client graph
// reaches several of them, and zod-validating every server var is a large,
// entirely unused cost there. `env.IS_BUILD` still re-exports this, so existing
// callsites are unchanged.
const isNextBuild =
  process.argv.some((arg) => arg.includes('next')) && process.argv.some((arg) => arg === 'build');

export const IS_BUILD = process.env.IS_BUILD === 'true' || isNextBuild;
