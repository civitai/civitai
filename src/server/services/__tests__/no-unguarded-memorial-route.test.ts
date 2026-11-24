import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * GUARD: every memorial route checks its caller first. `assertMemorialModerator` holds the
 * permission and the impersonation refusal, and the two-person rule depends on both; a route that
 * forgot it would let any moderator, or one impersonating another, write the memorial.
 */

const ROUTES_DIR = path.resolve(__dirname, '../../api-routes/mod/user');
const GATE = 'await assertMemorialModerator(ctx);';

/** The routes whose handler does anything before the gate, or never calls it. */
function unguardedMemorialRoutes(routes: { name: string; source: string }[]) {
  return routes
    .filter(({ source }) => {
      const body = source.slice(source.indexOf('async handler('));
      const firstStatement = body.slice(body.indexOf('{') + 1).trimStart();
      return !firstStatement.startsWith(GATE);
    })
    .map(({ name }) => name);
}

const routes = readdirSync(ROUTES_DIR)
  .filter((name) => name.startsWith('memorial-') && name.endsWith('.ts'))
  .map((name) => ({ name, source: readFileSync(path.join(ROUTES_DIR, name), 'utf8') }));

describe('memorial routes check their caller first', () => {
  it('finds the three memorial routes', () => {
    expect(routes.map((r) => r.name).sort()).toEqual([
      'memorial-confirm.ts',
      'memorial-propose.ts',
      'memorial-reverse.ts',
    ]);
  });

  it('every one calls assertMemorialModerator(ctx) before any other work', () => {
    expect(unguardedMemorialRoutes(routes)).toEqual([]);
  });

  it('control: a route without the call, or with work before it, is named', () => {
    const [route] = routes;
    const without = { name: 'without.ts', source: route.source.replace(GATE, '') };
    const late = {
      name: 'late.ts',
      source: route.source.replace(GATE, `await Promise.resolve();\n    ${GATE}`),
    };
    expect(unguardedMemorialRoutes([without, late])).toEqual(['without.ts', 'late.ts']);
  });
});
