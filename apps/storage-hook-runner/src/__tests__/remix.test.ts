import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.ts';
import {
  MAX_REMIX_ANSWER_CHARS,
  MAX_REMIX_BRANCHES,
  MAX_REMIX_EFFECTS,
  MAX_REMIX_SOURCE_BYTES,
  REMIX_QUARANTINE_MS,
  REMIX_REPLAY_TIMEOUT_MS,
  SIG_HEADER,
} from '../limits.ts';
import { createMetrics } from '../metrics.ts';
import { HookPool } from '../pool.ts';
import { PICK_OF_FOUR, SECRET, checkBody, hmac, sha256 } from '../test-support/fixtures.ts';

/** `POST /v1/remix/replay` through the real Fastify app and the real worker pool. */

const IMAGE = { imageId: 7, url: 'https://image.example/source.png', width: 1200, height: 800 };
const take = (n: number) => ({ url: `https://blobs.example/take-${n}.png` });
const TAKES = { type: 'workflow', result: { workflowId: 'wf-1', images: [0, 1, 2, 3].map(take) } };

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

function replayBody(
  source: string,
  input: { base?: unknown[]; branches?: unknown[][]; autoAnswer?: 'first' } = {}
) {
  return {
    ts: Math.floor(Date.now() / 1000),
    appId: 'remix-u5-probe',
    sha256: sha256(source),
    source,
    input: { source: IMAGE, base: [], ...input },
  };
}

async function replay(source: string, input?: Parameters<typeof replayBody>[1]) {
  const body = JSON.stringify(replayBody(source, input));
  const res = await app.inject({
    method: 'POST',
    url: '/v1/remix/replay',
    headers: { 'content-type': 'application/json', [SIG_HEADER]: hmac(SECRET, body) },
    payload: body,
  });
  return res;
}

const results = async (source: string, input?: Parameters<typeof replayBody>[1]) => {
  const res = await replay(source, input);
  expect(res.statusCode).toBe(200);
  expect(res.headers[SIG_HEADER]).toBe(hmac(SECRET, res.body));
  return res.json().results as Record<string, unknown>[];
};

/** An app whose only step is one ask, whose prompt reports `expr` as evaluated inside the VM. */
const reporting = (expr: string) => `
export default defineRemixApp({
  async run(ctx) {
    await ctx.ask({ kind: 'text', prompt: String(${expr}), maxLength: 10 });
    return [];
  },
});`;
const reported = async (expr: string) => {
  const [result] = await results(reporting(expr));
  return (result.effects as { spec: { prompt: string } }[])[0].spec.prompt;
};

describe('POST /v1/remix/replay: Pick of four', () => {
  it('stops at the first step the log has no entry for, and finishes on a full log', async () => {
    const [start, atPick, done] = await results(PICK_OF_FOUR, {
      base: [],
      branches: [[TAKES], [TAKES, { type: 'ask', answer: 2 }, { type: 'ask', answer: 'keep' }]],
    });
    expect(start).toEqual({
      effects: [
        {
          type: 'workflow',
          request: {
            kind: 'image',
            prompt: 'Reimagine this image',
            images: [IMAGE],
            aspectRatio: 'source',
            quantity: 4,
          },
        },
      ],
    });
    expect((atPick.effects as unknown[]).at(-1)).toMatchObject({
      type: 'ask',
      spec: { kind: 'pick' },
    });
    expect(done).toMatchObject({ done: { outputs: [take(2)] } });
  });

  it(`answers ${1 + MAX_REMIX_BRANCHES} replays in one call, inside the backstop`, async () => {
    const atChoice = [TAKES, { type: 'ask', answer: 1 }];
    const branches = Array.from({ length: MAX_REMIX_BRANCHES }, (_, i) => [
      { type: 'ask', answer: i % 2 ? 'keep' : 'upscale' },
    ]);
    const res = await replay(PICK_OF_FOUR, { base: atChoice, branches });
    // A 500 here would be the backstop.
    expect(res.statusCode).toBe(200);
    const all = res.json().results as Record<string, unknown>[];
    expect(all).toHaveLength(1 + MAX_REMIX_BRANCHES);
    const last = (r: Record<string, unknown>) => (r.effects as unknown[]).at(-1);
    expect(all[0]).not.toHaveProperty('done');
    expect(last(all[0])).toMatchObject({ type: 'ask', spec: { kind: 'choice' } });
    const upscale = { type: 'workflow', request: { kind: 'upscale', image: take(1), scale: 2 } };
    expect(all[1]).not.toHaveProperty('done');
    expect(last(all[1])).toEqual(upscale);
    expect(all[2]).toMatchObject({ done: { outputs: [take(1)] } });
    // Every branch answers from the base alone, never from a sibling's log.
    all.slice(1).forEach((r, i) => expect(r).toEqual(all[1 + (i % 2)]));
  });

  it('with autoAnswer, answers each ask with its first answer until the first workflow', async () => {
    const asksFirst = `
export default defineRemixApp({
  async run(ctx) {
    const style = await ctx.ask({ kind: 'choice', prompt: 'Style?', options: [{ value: 'anime', label: 'Anime' }, { value: 'clay', label: 'Clay' }] });
    const extra = await ctx.ask({ kind: 'text', prompt: 'Extra?', maxLength: 20 });
    const { images } = await ctx.workflow({ kind: 'image', prompt: style + ' ' + extra, images: [ctx.source], aspectRatio: 'source', quantity: 1 });
    return images;
  },
});`;
    const [result] = await results(asksFirst, { autoAnswer: 'first' });
    expect(result.effects).toMatchObject([
      { type: 'ask', answer: 'anime' },
      { type: 'ask', answer: 'remix' },
      { type: 'workflow', request: { prompt: 'anime remix' } },
    ]);
    // POSITIVE CONTROL: without it, the replay stops at the first ask.
    const [plain] = await results(asksFirst);
    expect(plain.effects).toEqual([expect.objectContaining({ type: 'ask' })]);
    expect(plain.effects).not.toContainEqual(
      expect.objectContaining({ answer: expect.anything() })
    );
  });
});

describe('POST /v1/remix/replay: auto-answer values', () => {
  const choiceOf = (value: string) => `
export default defineRemixApp({
  async run(ctx) {
    await ctx.ask({ kind: 'choice', prompt: 'Which?', options: [{ value: ${value}, label: 'A' }] });
    return [];
  },
});`;

  it.each([
    ['an object', '{ nested: true }'],
    ['a string over the answer cap', `'x'.repeat(${MAX_REMIX_ANSWER_CHARS + 1})`],
    ['a non-finite number', 'Infinity'],
    // The log carries a number answer back only as a non-negative integer.
    ['a negative number', '-1'],
    ['a fraction', '2.5'],
    ['an unsafe integer', '2 ** 53'],
    ['undefined', 'undefined'],
  ])("refuses an option whose value is %s as the app's invalid_result", async (_what, value) => {
    const [result] = await results(choiceOf(value), { autoAnswer: 'first' });
    expect(result).toMatchObject({ cause: 'invalid_result' });
  });

  it('answers with an option value at the cap, or a non-negative integer', async () => {
    const [atCap] = await results(choiceOf(`'x'.repeat(${MAX_REMIX_ANSWER_CHARS})`), {
      autoAnswer: 'first',
    });
    expect(atCap).toMatchObject({ done: { outputs: [] } });
    expect((atCap.effects as { answer: string }[])[0].answer).toHaveLength(MAX_REMIX_ANSWER_CHARS);
    const [num] = await results(choiceOf('2'), { autoAnswer: 'first' });
    expect((num.effects as { answer: number }[])[0].answer).toBe(2);
  });
});

describe('POST /v1/remix/replay: auto-answers the app cannot steer', () => {
  it('records no ask whose option getter took a step', async () => {
    const app = (getter: boolean) => `
export default defineRemixApp({
  async run(ctx) {
    const option = { label: 'A' };
    Object.defineProperty(option, 'value', { enumerable: true, get() {
      ${getter ? "ctx.workflow({ kind: 'upscale', image: ctx.source, scale: 2 });" : ''}
      return 'a';
    } });
    await ctx.ask({ kind: 'choice', prompt: 'Which?', options: [option] });
    return [];
  },
});`;
    // POSITIVE CONTROL: without the step, the ask is auto-answered.
    const [plain] = await results(app(false), { autoAnswer: 'first' });
    expect(plain.effects).toEqual([expect.objectContaining({ type: 'ask', answer: 'a' })]);
    const [result] = await results(app(true), { autoAnswer: 'first' });
    expect((result.effects as { type: string }[]).map(({ type }) => type)).toEqual(['workflow']);
  });

  it('auto-answers only when the caller asks, whatever Object.prototype claims', async () => {
    const asker = `Object.prototype.autoAnswer = 'first';
export default defineRemixApp({
  async run(ctx) {
    await ctx.ask({ kind: 'text', prompt: 'Who?', maxLength: 40 });
    return [];
  },
});`;
    const [result] = await results(asker);
    expect(result.effects).toEqual([
      { type: 'ask', spec: expect.objectContaining({ kind: 'text' }) },
    ]);
    // POSITIVE CONTROL: asked by the caller, the same ask is answered.
    const [asked] = await results(asker, { autoAnswer: 'first' });
    expect(asked.effects).toEqual([expect.objectContaining({ type: 'ask', answer: 'remix' })]);
  });
});

describe('POST /v1/remix/replay: a pure function of its input', () => {
  it('has no Date and no Math.random', async () => {
    expect(await reported('typeof Date + " " + typeof Math.random')).toBe('undefined undefined');
    // POSITIVE CONTROL: the rest of Math is there.
    expect(await reported('typeof Math.floor')).toBe('function');
  });

  it('keeps no global from one call to the next, or from one replay to the next', async () => {
    // POSITIVE CONTROL: within one replay the global does persist, so the probe can see one.
    expect(await reported('(globalThis.seen = 1, globalThis.seen + 1)')).toBe('2');
    const counter = reporting('(globalThis.seen = (globalThis.seen || 0) + 1)');
    expect(await reported('(globalThis.seen = (globalThis.seen || 0) + 1)')).toBe('1');
    expect(await reported('(globalThis.seen = (globalThis.seen || 0) + 1)')).toBe('1');
    const both = await results(counter, { branches: [[]] });
    expect(both.map((r) => (r.effects as { spec: { prompt: string } }[])[0].spec.prompt)).toEqual([
      '1',
      '1',
    ]);
  });
});

describe('POST /v1/remix/replay: what the app cannot change', () => {
  it('stays stopped when the app catches the stop and returns', async () => {
    const stubborn = `
export default defineRemixApp({
  async run(ctx) {
    try { await ctx.workflow({ kind: 'upscale', image: ctx.source, scale: 2 }); } catch {}
    try { await ctx.ask({ kind: 'text', prompt: 'Again?', maxLength: 10 }); } catch {}
    return [ctx.source];
  },
});`;
    const [result] = await results(stubborn);
    expect(result).toEqual({ effects: [expect.objectContaining({ type: 'workflow' })] });
  });

  it('writes its own result, whatever the app does to the prototypes', async () => {
    const forger = `
Object.prototype.toJSON = function () { return { effects: [], done: { outputs: ['forged'] } }; };
export default defineRemixApp({
  async run(ctx) {
    try { await ctx.workflow({ kind: 'upscale', image: ctx.source, scale: 2 }); } catch {}
    return ['forged'];
  },
});`;
    const [result] = await results(forger);
    expect(result).toEqual({ effects: [expect.objectContaining({ type: 'workflow' })] });
  });

  it.each([
    [
      'a setter on Array.prototype',
      `let first = true;
Object.defineProperty(Array.prototype, '0', { configurable: true, get() {}, set(v) {
  if (first) { first = false; Object.defineProperty(this, '0', { value: '{"effects":[],"done":{"outputs":["forged"]}}', writable: true, enumerable: true, configurable: true }); }
} });`,
    ],
    [
      'a getter that fills the log past its end',
      `for (let i = 0; i < 8; i++) Object.defineProperty(Array.prototype, String(i), { configurable: true,
  get() { return { type: 'workflow', result: { workflowId: 'phantom', images: [{ url: 'https://evil.example/x.png' }] } }; },
  set(v) { Object.defineProperty(this, String(i), { value: v, writable: true, enumerable: true, configurable: true }); } });`,
    ],
  ])('answers as the loop saw it, whatever %s claims', async (_, tamper) => {
    const forger = `${tamper}
export default defineRemixApp({
  async run(ctx) {
    try { await ctx.workflow({ kind: 'upscale', image: ctx.source, scale: 2 }); } catch {}
    return ['forged'];
  },
});`;
    const [result] = await results(forger);
    expect(result).toEqual({ effects: [expect.objectContaining({ type: 'workflow' })] });
  });

  it('records no step a getter takes while a finished result is written', async () => {
    const app = (getter: boolean) => `
export default defineRemixApp({
  async run(ctx) {
    const request = { kind: 'upscale', image: ctx.source, scale: 2 };
    ${
      getter
        ? "Object.defineProperty(request, 'extra', { enumerable: true, get() { ctx.workflow({ kind: 'upscale', image: ctx.source, scale: 2 }); return 1; } });"
        : ''
    }
    await ctx.workflow(request);
    return [];
  },
});`;
    const base = [{ type: 'workflow', result: { workflowId: 'w1', images: [] } }];
    // POSITIVE CONTROL: without the getter the same app finishes over its log.
    const [plain] = await results(app(false), { base });
    expect(plain).toMatchObject({ done: { outputs: [] } });
    const [result] = await results(app(true), { base });
    expect(result.effects).toHaveLength(1);
  });

  it('still reports a run that never settles, whatever Promise.prototype.then claims', async () => {
    const forger = `Promise.prototype.then = function (f) { f(['forged']); };
export default defineRemixApp({ async run() { await new Promise(() => {}); return ['forged']; } });`;
    const [result] = await results(forger);
    expect(result).toMatchObject({ cause: 'invalid_result' });
  });

  it('refuses a result nested too deep to cross to the host, without a runner fault', async () => {
    const deep = `
export default defineRemixApp({
  async run(ctx) {
    let r = 0;
    for (let i = 0; i < 4000; i++) r = [r];
    await ctx.workflow(r);
    return [];
  },
});`;
    const all = await results(deep, { branches: [[]] });
    expect(all).toEqual([
      expect.objectContaining({ cause: 'invalid_result' }),
      expect.objectContaining({ cause: 'invalid_result' }),
    ]);
  });

  it('refuses a run that finishes before its log ends', async () => {
    const [result] = await results(
      'export default defineRemixApp({ async run() { return []; } });',
      {
        base: [{ type: 'ask', answer: 'a' }],
      }
    );
    expect(result).toMatchObject({ cause: 'invalid_result' });
    // POSITIVE CONTROL: on an empty log the same app is done.
    const [done] = await results('export default defineRemixApp({ async run() { return []; } });');
    expect(done).toMatchObject({ done: { outputs: [] } });
  });

  it('stops at a step whose type the log disagrees with', async () => {
    const [result] = await results(PICK_OF_FOUR, { base: [{ type: 'ask', answer: 0 }] });
    expect(result).toEqual({ effects: [expect.objectContaining({ type: 'workflow' })] });
  });

  it(`returns at most ${MAX_REMIX_EFFECTS + 1} effects, the last past the limit`, async () => {
    const asker = `
export default defineRemixApp({
  async run(ctx) {
    for (;;) await ctx.ask({ kind: 'text', prompt: 'More?', maxLength: 10 });
  },
});`;
    // Answering every ask itself, the loop alone would run to the deadline.
    const [result] = await results(asker, { autoAnswer: 'first' });
    expect(result.effects).toHaveLength(MAX_REMIX_EFFECTS + 1);
  });
});

describe("POST /v1/remix/replay: faults are the author's, per replay", () => {
  it.each([
    ['a loop', 'export default defineRemixApp({ async run() { for (;;) {} } });', 'timeout'],
    [
      'a promise loop',
      'export default defineRemixApp({ async run() { for (;;) await null; } });',
      'timeout',
    ],
    [
      'a run that never settles',
      'export default defineRemixApp({ run: () => new Promise(() => {}) });',
      'invalid_result',
    ],
    [
      'a throw',
      'export default defineRemixApp({ async run() { throw new Error("no"); } });',
      'error',
    ],
    ['no app', 'export default 42;', 'error'],
    ['a syntax error', 'export default defineRemixApp({', 'error'],
  ])('%s answers %s', async (_, source, cause) => {
    const [result] = await results(source);
    expect(result).toMatchObject({ cause });
  });
});

it(`gives each of ${1 + MAX_REMIX_BRANCHES} looping replays its own deadline`, async () => {
  // Its own pool, with a backstop far past the call's: a CI host slow enough to push the call
  // past remixBudgetMs would otherwise turn it into a 423 and quarantine the shared app.
  const p = await HookPool.start({ size: 1, backstopMs: 30_000 });
  const a = buildApp({ secret: SECRET, mode: 'remix', pool: p, metrics: createMetrics() });
  try {
    const loop = 'export default defineRemixApp({ async run() { for (;;) {} } });';
    const body = JSON.stringify(
      replayBody(loop, { branches: Array.from({ length: MAX_REMIX_BRANCHES }, () => []) })
    );
    const res = await a.inject({
      method: 'POST',
      url: '/v1/remix/replay',
      headers: { 'content-type': 'application/json', [SIG_HEADER]: hmac(SECRET, body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const { results: all, elapsedMs } = res.json() as {
      results: Record<string, unknown>[];
      elapsedMs: number;
    };
    expect(all).toHaveLength(1 + MAX_REMIX_BRANCHES);
    expect(all.every((r) => r.cause === 'timeout')).toBe(true);
    // Each replay ran to its own deadline, not one shared by the call.
    expect(elapsedMs).toBeGreaterThanOrEqual((1 + MAX_REMIX_BRANCHES) * REMIX_REPLAY_TIMEOUT_MS);
  } finally {
    await a.close();
    await p.close();
  }
});

describe('quarantine after the backstop', () => {
  // A native intrinsic that never polls the interrupt: a sparse array's includes walks 2^32 - 1
  // holes inside QuickJS. Only the backstop stops it.
  const OUTRUNS = `export default defineRemixApp({ async run() {
  const a = []; a.length = 2 ** 32 - 1; a.includes(1); return [];
} });`;

  it('refuses 423 quarantined, signed, for the call that hit the backstop and every later call of that app, until it expires', async () => {
    let now = 0;
    const p = await HookPool.start({ size: 1 });
    const a = buildApp({
      secret: SECRET,
      mode: 'remix',
      pool: p,
      metrics: createMetrics(),
      nowMs: () => now,
    });
    const call = (source: string, appId: string) => {
      const body = JSON.stringify({ ...replayBody(source), appId });
      return a.inject({
        method: 'POST',
        url: '/v1/remix/replay',
        headers: { 'content-type': 'application/json', [SIG_HEADER]: hmac(SECRET, body) },
        payload: body,
      });
    };
    try {
      const hit = await call(OUTRUNS, 'remix-outruns');
      expect(hit.statusCode).toBe(423);
      expect(hit.json().error.code).toBe('quarantined');
      expect(hit.json().error.message).toContain('outran the interrupt');
      expect(hit.json().error.tripped).toBe(true);
      expect(hit.headers[SIG_HEADER]).toBe(hmac(SECRET, hit.body));
      expect(p.stats().terminated).toBe(1);

      // The same source again is refused without reaching a worker.
      const later = await call(OUTRUNS, 'remix-outruns');
      expect(later.statusCode).toBe(423);
      expect(later.json().error.code).toBe('quarantined');
      expect(later.json().error.tripped).toBe(false);
      expect(p.stats().terminated).toBe(1);

      // A new source of the same app starts clean, and another app is answered.
      expect((await call(PICK_OF_FOUR, 'remix-outruns')).statusCode).toBe(200);
      expect((await call(PICK_OF_FOUR, 'remix-other')).statusCode).toBe(200);

      now += REMIX_QUARANTINE_MS - 1;
      expect((await call(OUTRUNS, 'remix-outruns')).statusCode).toBe(423);
      expect(p.stats().terminated).toBe(1);
      // Expired: the source runs again, and outruns the interrupt again.
      now += 1;
      const again = await call(OUTRUNS, 'remix-outruns');
      expect(again.statusCode).toBe(423);
      expect(again.json().error.tripped).toBe(true);
      expect(p.stats().terminated).toBe(2);
    } finally {
      await a.close();
      await p.close();
    }
  });
});

it('counts one trip when calls admitted together all outrun the interrupt', async () => {
  const OUTRUNS = `export default defineRemixApp({ async run() {
  const a = []; a.length = 2 ** 32 - 1; a.includes(1); return [];
} });`;
  const p = await HookPool.start({ size: 2 });
  const a = buildApp({ secret: SECRET, mode: 'remix', pool: p, metrics: createMetrics() });
  try {
    const body = JSON.stringify({ ...replayBody(OUTRUNS), appId: 'remix-together' });
    const call = () =>
      a.inject({
        method: 'POST',
        url: '/v1/remix/replay',
        headers: { 'content-type': 'application/json', [SIG_HEADER]: hmac(SECRET, body) },
        payload: body,
      });
    const answers = await Promise.all([call(), call()]);
    expect(answers.map((res) => res.statusCode)).toEqual([423, 423]);
    expect(p.stats().terminated).toBe(2);
    expect(answers.map((res) => res.json().error.tripped).sort()).toEqual([false, true]);
  } finally {
    await a.close();
    await p.close();
  }
});

describe('remix mode', () => {
  it('does not serve /v1/check, even to a signed request', async () => {
    const body = JSON.stringify(
      checkBody('export default function check() { return { allow: true }; }')
    );
    const res = await app.inject({
      method: 'POST',
      url: '/v1/check',
      headers: { 'content-type': 'application/json', [SIG_HEADER]: hmac(SECRET, body) },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
    // POSITIVE CONTROL: the same process serves its own route.
    expect((await replay(PICK_OF_FOUR)).statusCode).toBe(200);
  });

  it('/readyz self-tests a remix app that finishes and one the interrupt stops', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, checks: { finish: true, interrupt: true } });
  });
});

describe('POST /v1/remix/replay: refusals', () => {
  it('refuses an unsigned request', async () => {
    const body = JSON.stringify(replayBody(PICK_OF_FOUR));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/remix/replay',
      headers: { 'content-type': 'application/json', [SIG_HEADER]: hmac(`${SECRET}x`, body) },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });

  it(`refuses a source over ${MAX_REMIX_SOURCE_BYTES} bytes`, async () => {
    const big = `${PICK_OF_FOUR}\n//${'x'.repeat(MAX_REMIX_SOURCE_BYTES)}`;
    expect((await replay(big)).json().error.code).toBe('source_too_large');
    // POSITIVE CONTROL: the same app at its own size replays.
    expect((await replay(PICK_OF_FOUR)).statusCode).toBe(200);
  });

  it(`refuses more than ${MAX_REMIX_BRANCHES} branches, or a branch past ${MAX_REMIX_EFFECTS} entries`, async () => {
    const many = Array.from({ length: MAX_REMIX_BRANCHES + 1 }, () => []);
    expect((await replay(PICK_OF_FOUR, { branches: many })).statusCode).toBe(400);
    const asks = (n: number) => Array.from({ length: n }, () => ({ type: 'ask', answer: 0 }));
    const base = asks(10);
    expect(
      (await replay(PICK_OF_FOUR, { base, branches: [asks(MAX_REMIX_EFFECTS - 9)] })).statusCode
    ).toBe(400);
    // POSITIVE CONTROL: one entry fewer fits.
    expect(
      (await replay(PICK_OF_FOUR, { base, branches: [asks(MAX_REMIX_EFFECTS - 10)] })).statusCode
    ).toBe(200);
  });
});
