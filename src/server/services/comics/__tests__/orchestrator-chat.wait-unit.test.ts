import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as WorkflowsMod from '~/server/services/orchestrator/workflows';

/**
 * The orchestrator's `?wait` query param on the v2 workflow API is SECONDS.
 *
 * Authority (not inference): `WorkflowsController.cs` binds it as
 * `[FromQuery] int wait = 0` and applies it as `TimeSpan.FromSeconds(wait)` on
 * both the submit and the get handler. There is NO server-side clamp — the
 * generated OpenAPI schema carries no `minimum`/`maximum`, and nothing between
 * the binding and `FromSeconds` rewrites the value. Whatever we send is held.
 *
 * These tests exist because `orchestrator-chat.ts` shipped `wait: 60000` — a
 * millisecond value in a seconds field, i.e. a request to hold the socket for
 * ~16.7 hours. The generated contract types it `wait?: number`, so TypeScript
 * cannot tell 60000 seconds from 60000 milliseconds. Only a bound can.
 */

/**
 * Upper bound on any `wait` we send, in seconds.
 *
 * Derived, not arbitrary. `submitWorkflow` only bounds an attempt with an
 * `AbortSignal.timeout` on the whatIf path, so a real submit has no
 * client-side abort — the practical ceiling is undici's ~300s default headers
 * timeout. A `wait` above that never gets to return its graceful 202: the
 * fetch throws first, `submitWorkflowWithRetry` scores that as transient, and
 * re-submits. Since these bodies carry no `externalId` the orchestrator cannot
 * dedupe, so exceeding this bound converts one billable job into up to three.
 *
 * The repo's own debug endpoint already encodes a stricter version of this
 * (`src/pages/api/testing/xguard-test.ts` bounds wait with `.max(120)`).
 */
const MAX_WAIT_SECONDS = 300;

const { mockSubmitWorkflow } = vi.hoisted(() => ({ mockSubmitWorkflow: vi.fn() }));

// Spread the real module and override only `submitWorkflow` (house rule
// local-rules/no-wholesale-module-mock): a hand-written factory silently
// collects 0 tests the day the module gains an export it omits.
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<typeof WorkflowsMod>()),
  submitWorkflow: mockSubmitWorkflow,
}));

import { orchestratorChatCompletion } from '~/server/services/comics/orchestrator-chat';

beforeEach(() => {
  vi.clearAllMocks();
  mockSubmitWorkflow.mockResolvedValue({
    id: 'wf-1',
    steps: [{ output: { choices: [{ message: { content: 'hi' } }] } }],
  });
});

const callOnce = async () => {
  await orchestratorChatCompletion({
    token: 't',
    messages: [{ role: 'user', content: 'hello' }],
  });
  expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
  return mockSubmitWorkflow.mock.calls[0][0] as { query?: { wait?: unknown } };
};

describe('orchestratorChatCompletion — the `wait` it sends is a SECONDS value', () => {
  // THE regression assertion. At base this reads 60000 and fails on the upper
  // bound. It deliberately asserts an ENVELOPE, not the literal 60 — a test
  // pinned to the literal would have to be edited to accept a future retune and
  // would stop expressing the unit, which is the thing that actually regressed.
  it('sends a wait inside the seconds envelope, not a millisecond value', async () => {
    const arg = await callOnce();
    const wait = arg.query?.wait;

    expect(typeof wait).toBe('number');
    expect(Number.isInteger(wait)).toBe(true);
    // > 0 matters: the caller reads `workflow.steps[0].output` inline off the
    // submit response, so `wait: 0` (return immediately) would make every
    // completion come back empty.
    expect(wait as number).toBeGreaterThan(0);
    expect(wait as number).toBeLessThanOrEqual(MAX_WAIT_SECONDS);
  });

  it('sends a wait long enough for a gpt-4o-mini completion to land', async () => {
    // The floor is the consuming side, not the protocol. An expired wait yields
    // a 202 with no step output → `content: ''` → story-plan.ts refunds the
    // user's Buzz and throws a user-visible error. SCAN_WAIT_SECONDS (10) is the
    // smallest wait anything in this repo asks for; a chat completion capped at
    // maxTokens 2048 needs at least that.
    const arg = await callOnce();
    expect(arg.query?.wait as number).toBeGreaterThanOrEqual(10);
  });
});

/**
 * Repo-wide seam guard. The behavioural test above pins ONE call site; this
 * pins the RELATIONSHIP — the set of places that hand a `wait` to the v2
 * workflow API — so a new site cannot be added below the radar, and an existing
 * one cannot silently grow a millisecond value.
 */
describe('every v2 `query: { wait }` site in src/ passes seconds', () => {
  const SRC = path.resolve(__dirname, '../../../..'); // -> src/
  const QUERY_WAIT = /query:\s*\{\s*wait:\s*([A-Za-z0-9_]+)\s*\}/g;

  /** Resolve a `query: { wait: X }` token: a numeric literal, or a same-file `const X = <number>`. */
  const resolveWait = (token: string, source: string): number | undefined => {
    if (/^\d+$/.test(token)) return Number(token);
    const decl = new RegExp(`const\\s+${token}\\s*=\\s*(\\d[\\d_]*)\\s*;`).exec(source);
    return decl ? Number(decl[1].replace(/_/g, '')) : undefined;
  };

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p, out);
      } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) {
        out.push(p);
      }
    }
    return out;
  };

  const sites = walk(SRC).flatMap((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return [...source.matchAll(QUERY_WAIT)].map((m) => ({
      file: path.relative(SRC, file),
      token: m[1],
      seconds: resolveWait(m[1], source),
    }));
  });

  // POSITIVE CONTROL. A zero here would be indistinguishable from a scanner
  // wired to nothing — the regex silently not matching would make every
  // assertion below vacuously pass.
  it('the scanner actually finds sites (positive control)', () => {
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  // A site whose value is only known at runtime cannot be bounded statically,
  // so it must instead make the unit legible at the call site — which is the
  // root cause this whole file guards. Both current such sites comply
  // (`waitSeconds`, `PERCEPTUAL_HASH_WAIT_SECONDS`), and each is separately
  // clamped in its own module (MAX_BLOCK_POLL_WAIT_SECONDS = 15; the perceptual
  // hash pairs its 30 with a 45s AbortSignal).
  it('a runtime-valued wait names its unit', () => {
    const unresolved = sites.filter((s) => s.seconds === undefined);
    expect(unresolved.filter((s) => !/seconds/i.test(s.token))).toEqual([]);
  });

  // NEGATIVE CONTROL. Proves the resolver+bound can go red on a known-bad
  // input, so the green verdict above is a fact about the code and not about a
  // broken harness.
  it('the resolver rejects a known-bad millisecond value (negative control)', () => {
    expect(resolveWait('60000', '')).toBe(60000);
    expect(resolveWait('60000', '') as number).toBeGreaterThan(MAX_WAIT_SECONDS);
    expect(resolveWait('X', 'const X = 60_000;')).toBe(60000);
  });

  it('no statically-known site exceeds the seconds envelope', () => {
    const offenders = sites.filter(
      (s) => s.seconds !== undefined && s.seconds > MAX_WAIT_SECONDS
    );
    expect(offenders).toEqual([]);
  });

  // Fails when the set GROWS or SHRINKS. A new v2 wait site is a deliberate
  // decision about how long an api pod holds a socket, so it should land in a
  // diff that says so rather than arriving unnoticed.
  it('matches the known ledger of v2 wait sites', () => {
    expect(new Set(sites.map((s) => s.file))).toEqual(
      new Set([
        'server/routers/blocks.router.ts',
        'server/services/comics/orchestrator-chat.ts',
        'server/services/orchestrator/orchestrator.service.ts',
        'server/services/product-badge.service.ts',
        'server/services/training.service.ts',
      ])
    );
  });
});
