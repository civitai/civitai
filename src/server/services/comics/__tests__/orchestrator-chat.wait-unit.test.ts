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
 * Derived, not arbitrary: HALF the measured undici headers timeout.
 *
 * `submitWorkflow` only bounds an attempt with an `AbortSignal.timeout` on the
 * whatIf path, so a real submit has no client-side abort — the practical
 * ceiling is undici's default headers timeout, measured at 300.7s against a
 * server that accepts and never responds. A `wait` at or above that never gets
 * to return its graceful 202: the fetch throws first, and
 * `submitWorkflowWithRetry` re-submits (it retries on ANY throw — it is not
 * gated on an error allow-list). Since these bodies carry no `externalId` the
 * orchestrator cannot dedupe, so exceeding the timeout converts one billable
 * job into up to three.
 *
 * The bound is half of 300 rather than 300 itself because AT the timeout the
 * two outcomes are a race — the graceful 202 and the billed retry storm are
 * decided by jitter. A guard whose ceiling equals the hazard admits the
 * boundary value: with this at 300, `CHAT_COMPLETION_WAIT_SECONDS = 300`
 * passed every test in this file. Halving it makes that boundary fail while
 * still leaving generous room above any real completion.
 *
 * The repo's own debug endpoint independently bounds its wait with `.max(120)`
 * (`src/pages/api/testing/xguard-test.ts`), which sits under this.
 */
const MAX_WAIT_SECONDS = 150;

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
 * Repo-wide seam guard.
 *
 * SCOPE, stated precisely, because a guard that claims coverage it does not
 * have is worse than one that admits its limits: this bounds every `wait:`
 * whose value is a NUMBER RESOLVABLE STATICALLY — a literal, or a same-file
 * `const`. It is deliberately NOT scoped to `query: { … }`, because the two
 * `orchestrator.service.ts` wrappers forward an externally-supplied
 * `wait?: number` in via ES shorthand (`query: wait ? { wait } : undefined`),
 * and their callers — `text-output-moderation.ts`, `scanner-policies-test`,
 * `xguard-test`, and `submitTextModeration`, reachable from 5 modules — write
 * the actual number at THEIR call site under a plain `wait:` key. A scan
 * anchored on `query:` would miss all of them, so a new caller passing `60000`
 * through `submitTextModeration` would sail straight past this file.
 *
 * What it CANNOT bound is a value only known at runtime. Those are enumerated
 * separately below and pinned by ledger, not by value.
 */
describe('every statically-resolvable `wait:` in src/ is a seconds value', () => {
  const SRC = path.resolve(__dirname, '../../../..'); // -> src/
  // Any `wait:` property, wherever it appears — plus the ES-shorthand `{ wait }`
  // forward, captured as the sentinel token `wait` so it lands in the runtime
  // bucket rather than vanishing. Dots are allowed in the token so a forward
  // like `wait: input.wait` is SEEN and classified, not silently unmatched.
  const WAIT_SITE = /(?:\bwait:\s*([A-Za-z0-9_.]+)|\{\s*(wait)\s*\})/g;

  /** Resolve a `wait` token: a numeric literal, or a same-file `const X = <number>`. */
  const resolveWait = (token: string, source: string): number | undefined => {
    if (/^\d+$/.test(token)) return Number(token);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return undefined; // `input.wait` etc.
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

  /**
   * Strip comments before matching. Without this the scan reports prose: this
   * repo documents waits IN comments (`// A \`wait: 30\` request …`) and keeps a
   * commented-out `// wait: true,`, all of which were picked up as real sites.
   * A ledger polluted by prose is one nobody trusts, and a commented example is
   * exactly where a wrong value hides in plain sight.
   *
   * The line-comment rule ignores a `//` preceded by `:` so a URL inside a
   * string is not mistaken for a comment.
   */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  /**
   * A zod/schema builder in the value position declares the SHAPE of an inbound
   * HTTP param on one of our own endpoints — it is not an outbound orchestrator
   * wait. Excluded so the ledger tracks values we SEND. (The one such endpoint
   * that does forward to the orchestrator, `xguard-test.ts`, is still tracked
   * via its actual forward, `wait: input.wait`.)
   */
  const isSchemaDecl = (token: string) => /^z(\.|$)/.test(token) || /Schema/.test(token);

  const sites = walk(SRC).flatMap((file) => {
    const raw = fs.readFileSync(file, 'utf8');
    const source = stripComments(raw);
    return [...source.matchAll(WAIT_SITE)]
      .map((m) => {
        const token = m[1] ?? m[2];
        return {
          file: path.relative(SRC, file),
          token,
          seconds: resolveWait(token, source),
        };
      })
      .filter((s) => !isSchemaDecl(s.token));
  });
  const numeric = sites.filter((s) => s.seconds !== undefined);
  const runtime = sites.filter((s) => s.seconds === undefined);

  // POSITIVE CONTROL. A reassuring zero here would be indistinguishable from a
  // scanner wired to nothing. This asserts BOTH buckets are non-empty and that
  // the scanner reaches beyond this test's own neighbourhood — a bound that the
  // ledger tests below cannot also satisfy trivially, so it carries independent
  // signal rather than only failing alongside them.
  it('the scanner actually finds sites in both buckets (positive control)', () => {
    expect(numeric.length).toBeGreaterThan(0);
    expect(runtime.length).toBeGreaterThan(0);
    expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThan(3);
    // It must see the site this PR fixes, and the forwarding wrappers that the
    // previous `query:`-anchored regex could not match at all.
    expect(sites.map((s) => s.file)).toContain('server/services/comics/orchestrator-chat.ts');
    expect(sites.map((s) => s.file)).toContain(
      'server/services/orchestrator/orchestrator.service.ts'
    );
  });

  // NEGATIVE CONTROL. Proves the resolver+bound can go red on a known-bad
  // input, so the green verdicts here are facts about the code and not about a
  // broken harness. Covers both resolvable shapes.
  it('the resolver rejects a known-bad millisecond value (negative control)', () => {
    expect(resolveWait('60000', '')).toBe(60000);
    expect(resolveWait('60000', '') as number).toBeGreaterThan(MAX_WAIT_SECONDS);
    expect(resolveWait('X', 'const X = 60_000;')).toBe(60000);
    // and it must NOT pretend to resolve a member expression
    expect(resolveWait('input.wait', 'const wait = 5;')).toBeUndefined();
  });

  // The comment stripper is itself a harness component, so it gets its own
  // controls: it must remove a commented site (else the ledger fills with
  // prose) and must NOT eat a real one hiding behind a URL.
  it('the comment stripper drops prose but keeps code (controls)', () => {
    expect(stripComments('// wait: 60000,\nconst a = 1;')).not.toContain('60000');
    expect(stripComments('/* wait: 60000 */ const a = 1;')).not.toContain('60000');
    expect(stripComments('const u = "https://x.y"; f({ wait: 30 });')).toContain('wait: 30');
  });

  // THE bound. Any `wait:` anywhere in src/ that resolves to a number must be a
  // plausible seconds value — including one written at a caller that forwards
  // into the orchestrator wrappers rather than calling the client directly.
  it('no statically-resolvable wait exceeds the seconds envelope', () => {
    const offenders = numeric.filter((s) => (s.seconds as number) > MAX_WAIT_SECONDS);
    expect(offenders).toEqual([]);
  });

  // Fails when the set GROWS or SHRINKS. A new wait site is a deliberate
  // decision about how long an api pod holds a socket, so it should land in a
  // diff that says so rather than arriving unnoticed.
  it('matches the known ledger of numeric wait sites', () => {
    expect(new Set(numeric.map((s) => `${s.file}:${s.token}`))).toEqual(
      new Set([
        'server/services/blocks/steps/text-output-moderation.ts:SCAN_WAIT_SECONDS',
        'server/services/comics/orchestrator-chat.ts:CHAT_COMPLETION_WAIT_SECONDS',
        'server/services/orchestrator/orchestrator.service.ts:PERCEPTUAL_HASH_WAIT_SECONDS',
        'server/services/product-badge.service.ts:30',
        'server/services/training.service.ts:0',
      ])
    );
  });

  // The runtime bucket CANNOT be value-checked here — these forward a number
  // supplied by a caller (or, for `training.service.ts`, the v1 jobs API's
  // boolean `wait`, which is a different contract entirely and correctly not a
  // number). So they are pinned by ledger: a NEW unbounded forwarding path has
  // to be declared here, which is the point at which someone has to think about
  // whether it needs a clamp of its own.
  it('matches the known ledger of runtime-valued wait sites', () => {
    expect(new Set(runtime.map((s) => `${s.file}:${s.token}`))).toEqual(
      new Set([
        'server/routers/blocks.router.ts:waitSeconds',
        'server/services/orchestrator/orchestrator.service.ts:wait',
        'server/services/training.service.ts:true',
        'pages/api/testing/xguard-test.ts:input.wait',
      ])
    );
  });
});
