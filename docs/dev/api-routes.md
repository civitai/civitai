# API routes served through a catch-all

In the Pages Router every file under `src/pages/api/` is its own build entry, and build memory grows with
the entry count. A group of routes can instead live under `src/server/api-routes/<key>/` and be served by
one catch-all, `src/pages/api/<key>/[...path].ts`. URLs do not change: `src/server/api-routes/mod/homeblock/create.ts`
answers `/api/mod/homeblock/create`. `/api/mod` and `/api/admin` are served this way.

## Adding a route

1. Put the file under `src/server/api-routes/<key>/`, as a `.ts` file with the same default export it would
   have under `src/pages/api/<key>/`.
2. Run `pnpm run generate:api-routes`, which rewrites `src/server/utils/api-routes/<key>.generated.ts`.
   `lint.yml` runs it with `--check` on every PR, because a route missing from the map is a 404.

A route stays a file in `src/pages/api/<key>/` when it needs its own `export const config` (body parser,
size or response limits), has a dynamic segment, or sits next to a dynamic route there that would capture
it. The generator refuses a served route in any of those cases, and one a file of the same path in
`src/pages/api/<key>/` would shadow.

## Adding a key

1. Create `src/server/api-routes/<key>/` and move the routes in.
2. Add `src/pages/api/<key>/[...path].ts`:

   ```ts
   import { createApiRouter } from '~/server/utils/api-router';
   import { routes } from '~/server/utils/api-routes/<key>.generated';

   export default createApiRouter(routes);
   ```

3. Run `pnpm run generate:api-routes`. It refuses a key without its catch-all.

Each key gets its own map: a literal `import()` is resolved and compiled as part of the catch-all that
holds it, so one shared map would compile every key's routes into every catch-all.
