// Bans constructing a node-postgres Pool directly: `new Pool(...)` and `new pg.Pool(...)`.
//
// A pool built by hand misses the error listeners in packages/civitai-db/src/pool-guard.ts
// (`guardPool`), and without them a dropped database connection — every connection at once, on a
// failover — surfaces as an `'error'` event nobody listens to, which crashes the process. The
// @civitai/db builders attach them; build pools there.
//
// Required by each ESLint config that should enforce it (a `root: true` config inherits nothing from
// the others); each owns its allowlist, because override globs resolve relative to the config file.
//
// Limits: matches by name, so an aliased import (`import { Pool as P } from 'pg'; new P()`) is not
// caught, and a non-pg class named `Pool` would be. apps/event-engine/src/common has its own
// `root: true` config that does not include it. CI lints only changed files under src/, packages/ and
// apps/event-engine/ (.github/workflows/lint.yml), so in the other apps it is a local-lint check only.
const message =
  'Build pg pools with @civitai/db (createPool / createClients / createKyselyClients), which attach ' +
  'guardPool: without its listeners a dropped DB connection crashes the process. A pool that must ' +
  'stay standalone has to attach the same listeners and be allowlisted in its ESLint config.';

module.exports = {
  'no-restricted-syntax': [
    'error',
    { selector: "NewExpression[callee.type='Identifier'][callee.name='Pool']", message },
    {
      selector: "NewExpression[callee.type='MemberExpression'][callee.property.name='Pool']",
      message,
    },
  ],
};
