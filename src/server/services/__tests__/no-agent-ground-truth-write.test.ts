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
 *   1. No `/api/*` route writes the table.
 *   2. The shared XGuard token is checked by every `/api/xguard/*` route and reachable from nowhere else,
 *      so page routes (where reviewing happens, as a form action) stay cookie-and-human only.
 */

const MODERATOR_SRC = path.resolve(process.cwd(), 'apps/moderator/src');
const API_ROUTES = path.join(MODERATOR_SRC, 'routes/api');

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

  it('no API route writes human_judgement', () => {
    const offenders = filesUnder(API_ROUTES).filter((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return GROUND_TRUTH_WRITES.some((pattern) => pattern.test(source));
    });

    expect(
      offenders.map((f) => path.relative(process.cwd(), f)),
      'Ground truth is human-only. Reviewing happens in the browser; the agent API must never record a verdict.'
    ).toEqual([]);
  });

  it('checks the shared token in every /api/xguard route', () => {
    const xguard = path.join(API_ROUTES, 'xguard');
    expect(fs.existsSync(xguard), `${xguard} does not exist`).toBe(true);

    const unguarded = filesUnder(xguard).filter(
      (file) => !/requireXguardToken\(/.test(fs.readFileSync(file, 'utf8'))
    );

    expect(
      unguarded.map((f) => path.relative(process.cwd(), f)),
      'hooks.server.ts exempts /api/xguard/* from the session guard, so an endpoint that does not check the token itself is public.'
    ).toEqual([]);
  });

  it('never lets the shared token authenticate a page', () => {
    const offenders = filesUnder(path.join(MODERATOR_SRC, 'routes'))
      .filter((file) => !file.includes(path.join('api', 'xguard')))
      .filter((file) => /requireXguardToken/.test(fs.readFileSync(file, 'utf8')));

    expect(
      offenders.map((f) => path.relative(process.cwd(), f)),
      'The token has no user behind it. A page authenticated by it could reach the review form action, which writes ground truth.'
    ).toEqual([]);
  });
});
