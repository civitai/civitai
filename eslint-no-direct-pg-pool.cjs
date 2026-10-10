// Bans constructing a node-postgres Pool directly: `new Pool(...)` and `new pg.Pool(...)`.
//
// A pool built by hand misses the error listeners in packages/civitai-db/src/pool-guard.ts
// (`guardPool`), and without them a dropped database connection — every connection at once, on a
// failover — surfaces as an `'error'` event nobody listens to, which crashes the process. The
// @civitai/db builders attach them; build pools there.
//
// One definition, required by every ESLint config that lints TypeScript in this repo (each app with
// its own `root: true` config inherits nothing from the root one): the root .eslintrc.js,
// packages/.eslintrc.cjs, apps/event-engine/.eslintrc.js, apps/moderator/.eslintrc.cjs and
// apps/creator-studio/.eslintrc.cjs. Each config owns its own allowlist, because override globs
// resolve relative to the config file.
//
// Limits: matches by name, so an aliased import (`import { Pool as P } from 'pg'; new P()`) is not
// caught, and a non-pg class named `Pool` would be (none exists in the repo today).
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
