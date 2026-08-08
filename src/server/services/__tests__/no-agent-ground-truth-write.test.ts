import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * `human_judgement` is the XGuard lab's ground truth: what a HUMAN confirmed about what a model
 * proposed. If the agent API could write it, the ground truth would become a model agreeing with itself,
 * in rows indistinguishable from real ones — and every number derived from it would look fine.
 *
 * Two structural properties keep that from happening, and both are one careless edit away from being
 * lost silently. This test is the thing that notices.
 *
 *   1. Only the review form action writes the table — not a route, not a $lib/server helper.
 *   2. Every token-callable handler is wrapped in `WebhookEndpoint`, and no page is reachable that way, so
 *      page routes (where reviewing happens, as a form action) stay cookie-and-human only.
 */

const MODERATOR_SRC = path.resolve(process.cwd(), 'apps/moderator/src');
const API_ROUTES = path.join(MODERATOR_SRC, 'routes/api');
const SERVER_LIB = path.join(MODERATOR_SRC, 'lib/server');
const PAGE_FILES = ['+page.svelte', '+page.server.ts', '+layout.svelte', '+layout.server.ts'];
// The one file allowed to write ground truth: the review form action, reached only by a signed-in human.
const REVIEW_ACTION = path.join(MODERATOR_SRC, 'routes/xguard/+page.server.ts');

const GROUND_TRUTH_WRITES = [
  /insertInto\(\s*['"]human_judgement['"]/,
  /updateTable\(\s*['"]human_judgement['"]/,
  /deleteFrom\(\s*['"]human_judgement['"]/,
  /\bINSERT\s+INTO\s+human_judgement\b/i,
  /\bUPDATE\s+human_judgement\b/i,
  /\bDELETE\s+FROM\s+human_judgement\b/i,
];

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return /\.(ts|svelte)$/.test(entry.name) ? [full] : [];
  });
}

describe('agents cannot write XGuard ground truth', () => {
  it('has the moderator API routes where this test expects them', () => {
    // A moved directory would make every assertion below vacuously true, which is the same failure
    // this whole test exists to prevent — so the paths are asserted before anything is read.
    expect(fs.existsSync(API_ROUTES), `${API_ROUTES} does not exist`).toBe(true);
    expect(filesUnder(API_ROUTES).length).toBeGreaterThan(0);
  });

  it('writes ground truth from the review form action and nowhere else', () => {
    // Scanning only route files missed the obvious refactor: extract the insert into $lib/server and an
    // endpoint can call it while every assertion here still passes.
    const writers = [...filesUnder(API_ROUTES), ...filesUnder(SERVER_LIB), REVIEW_ACTION].filter(
      (file) => {
        const source = fs.readFileSync(file, 'utf8');
        return GROUND_TRUTH_WRITES.some((pattern) => pattern.test(source));
      }
    );

    expect(
      writers.map((f) => path.relative(process.cwd(), f)),
      'Ground truth is human-only. Reviewing is a page form action; nothing a token can reach may record a verdict.'
    ).toEqual([path.relative(process.cwd(), REVIEW_ACTION)]);
  });

  // The only two ways to define a service-authenticated handler. defineEndpoint (no prefix) is the
  // MODERATOR-session builder and is deliberately absent: an endpoint here must not be session-gated.
  const GUARDS = ['WebhookEndpoint(', 'defineWebhookEndpoint('];

  it('defines EVERY exported handler of a token-callable route through a guard', () => {
    // Per HANDLER, not per file. A guard checked once per file passes as soon as any one handler has it,
    // so adding a second method to an existing route file was the way to publish an unauthenticated
    // endpoint while this suite stayed green.
    const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
    const routes = [...filesUnder(path.join(API_ROUTES, 'xguard')), ...filesUnder(path.join(API_ROUTES, 'mod'))]
      .filter((f) => path.basename(f) === '+server.ts');
    expect(routes.length, 'no token-callable routes found — the paths moved').toBeGreaterThan(0);

    const bare = [];
    let handlers = 0;
    for (const file of routes) {
      const source = fs.readFileSync(file, 'utf8');
      for (const method of methods) {
        const at = source.indexOf('export const ' + method);
        if (at === -1) continue;
        handlers++;
        const rhs = source.slice(source.indexOf('=', at) + 1).trimStart();
        if (!GUARDS.some((guard) => rhs.startsWith(guard)))
          bare.push(path.relative(process.cwd(), file) + ' (' + method + ')');
      }
    }
    expect(handlers, 'matched no handlers — the declaration shape changed').toBeGreaterThan(0);
    expect(
      bare,
      'hooks.server.ts lets a VERIFIED token past the session guard, so a handler defined without one of these wrappers accepts any valid token rather than opting in.'
    ).toEqual([]);
  });

  it('puts no page under a token-callable route directory', () => {
    // A page there would answer a secret with no user behind it — and pages are where verdicts are written.
    const pages = filesUnder(path.join(MODERATOR_SRC, 'routes'))
      .filter((f) => PAGE_FILES.includes(path.basename(f)))
      .filter((f) => {
        const route = f.slice(path.join(MODERATOR_SRC, 'routes').length).split(path.sep).join('/');
        return route.startsWith('/api/');
      });
    expect(pages.map((f) => path.relative(process.cwd(), f))).toEqual([]);
  });
});
