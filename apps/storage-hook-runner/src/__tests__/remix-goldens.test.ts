import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.ts';
import { SIG_HEADER } from '../limits.ts';
import { createMetrics } from '../metrics.ts';
import { HookPool } from '../pool.ts';
import { SECRET, hmac, sha256 } from '../test-support/fixtures.ts';

/**
 * The modules civitai generates from a declarative spec (`remixSpecToSource`), each replayed here
 * over the log of its in-process dry run: the sandbox must make the same steps and return the same
 * images as `compileRemixApp` does for that spec. civitai's own tests run app objects, never
 * source, so only this sees the generated module run.
 */
const GOLDENS = new URL(
  '../../../../src/shared/remix-apps/__tests__/__goldens__/',
  import.meta.url
);

type TraceStep =
  | { type: 'workflow'; request: unknown; result: { workflowId: string; images: unknown[] } }
  | { type: 'ask'; spec: unknown; answer: string | number };
type Golden = { source: Record<string, unknown>; trace: TraceStep[]; outputs: unknown[] };

const goldens = readdirSync(GOLDENS)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({
    slug: name.slice(0, -'.js'.length),
    module: readFileSync(new URL(name, GOLDENS), 'utf8'),
    golden: JSON.parse(
      readFileSync(new URL(name.replace(/\.js$/, '.trace.json'), GOLDENS), 'utf8')
    ) as Golden,
  }));

/**
 * A step as civitai reads it off the runner: an image's schema keeps its url and size and drops
 * the rest (`src/shared/remix-apps/replay.ts`, "Not strict"), so `ctx.source` passed as an input
 * loses its `imageId` there, as it does in the dry run.
 */
function asCivitaiReads(effect: { type: string; request?: Record<string, unknown> }) {
  if (effect.type !== 'workflow' || !effect.request) return effect;
  const strip = (image: unknown) => {
    const { imageId: _, ...rest } = image as Record<string, unknown>;
    return rest;
  };
  const { images, image, ...request } = effect.request;
  return {
    ...effect,
    request: {
      ...request,
      ...(Array.isArray(images) ? { images: images.map(strip) } : {}),
      ...(image ? { image: strip(image) } : {}),
    },
  };
}

let pool: HookPool;
let app: FastifyInstance;
beforeAll(async () => {
  pool = await HookPool.start({ size: 2 });
  app = buildApp({ secret: SECRET, mode: 'remix', pool, metrics: createMetrics() });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await pool.close();
});

describe('generated remix modules on the real runner', () => {
  it('finds the goldens', () => {
    expect(goldens.length).toBeGreaterThan(1);
  });

  it.each(goldens.map((g) => [g.slug, g] as const))(
    '%s makes the golden steps and returns its outputs',
    async (_, { module, golden }) => {
      const base = golden.trace.map((step) =>
        step.type === 'workflow'
          ? { type: 'workflow', result: step.result }
          : { type: 'ask', answer: step.answer }
      );
      const body = JSON.stringify({
        ts: Math.floor(Date.now() / 1000),
        appId: 'remix-u5-generated',
        sha256: sha256(module),
        source: module,
        input: { source: golden.source, base },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/remix/replay',
        headers: { 'content-type': 'application/json', [SIG_HEADER]: hmac(SECRET, body) },
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      const [result] = res.json().results;
      expect({ ...result, effects: result.effects?.map(asCivitaiReads) }).toEqual({
        effects: golden.trace.map((step) =>
          step.type === 'workflow'
            ? { type: 'workflow', request: step.request }
            : { type: 'ask', spec: step.spec }
        ),
        done: { outputs: golden.outputs },
      });
    }
  );
});
