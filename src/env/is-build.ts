// Split out of `~/env/server` so modules needing only this flag don't pull the
// 958-line server env schema into their import graph — `_app`'s client graph
// reaches several of them, and zod-validating every server var is a large,
// entirely unused cost there. `env.IS_BUILD` still re-exports this, so existing
// callsites are unchanged.
// `process.argv` is Node-only and this module sits in `_app`'s client chunk graph
// (via server/logging/client). Nothing evaluates it in a browser today, but an
// unguarded read would throw TypeError the moment something imports IS_BUILD from
// a component — with the graph guard and typecheck both still green.
const argv = typeof process !== 'undefined' && Array.isArray(process.argv) ? process.argv : [];
const isNextBuild = argv.some((arg) => arg.includes('next')) && argv.some((arg) => arg === 'build');

export const IS_BUILD = process.env.IS_BUILD === 'true' || isNextBuild;
