import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PaddleService from '~/server/services/paddle.service';
import type * as StripeService from '~/server/services/stripe.service';

/**
 * Every `verifyCaptchaToken` caller must supply `meta` AND `ip`.
 *
 * `meta` is the only thing that distinguishes one captcha failure from another in
 * Axiom — without it a payment-flow failure and an onboarding failure are the same
 * opaque record. The two payment call sites passed none at all.
 *
 * `ip` is forwarded to Turnstile as `remoteip` and recorded on the failure log as
 * `clientReportedIp`. It is pinned here for the same reason as `meta`: it was
 * possible to delete `ip: ctx.ip` from a call site and keep the entire suite green.
 *
 * Two complementary guards, because neither alone is sufficient:
 *
 *  - The BEHAVIOURAL tests drive the real handlers and read the arguments that
 *    actually reach `verifyCaptchaToken`. They prove the value is correct, which a
 *    source-level check cannot (a structural check type-checks straight past a
 *    wrong argument).
 *
 *  - The LEDGER test enumerates every call site in `src/` and fails when the set
 *    GROWS or SHRINKS. The behavioural tests structurally cannot see a NEW caller
 *    added later without `meta` — that is exactly the regression this class of bug
 *    reappears as, and the ledger is the only thing that catches it.
 */

const { mockVerifyCaptchaToken } = vi.hoisted(() => ({
  mockVerifyCaptchaToken: vi.fn().mockResolvedValue(true),
}));

vi.mock('~/server/recaptcha/client', () => ({
  verifyCaptchaToken: mockVerifyCaptchaToken,
  createRecaptchaAssesment: vi.fn().mockResolvedValue({ score: 1, reasons: [] }),
}));

// Stop at the service boundary — the handler's work after the captcha check is
// irrelevant here. Spread the real modules so a newly-added export can't silently
// turn into `undefined` and break collection.
const { mockCreateBuzzPurchaseTransaction, mockGetPaymentIntent } = vi.hoisted(() => ({
  mockCreateBuzzPurchaseTransaction: vi.fn().mockResolvedValue({ id: 'txn_test' }),
  mockGetPaymentIntent: vi.fn().mockResolvedValue({ clientSecret: 'pi_test' }),
}));

vi.mock('~/server/services/paddle.service', async (importOriginal) => ({
  ...(await importOriginal<typeof PaddleService>()),
  createBuzzPurchaseTransaction: mockCreateBuzzPurchaseTransaction,
}));

vi.mock('~/server/services/stripe.service', async (importOriginal) => ({
  ...(await importOriginal<typeof StripeService>()),
  getPaymentIntent: mockGetPaymentIntent,
}));

// Module scope, NOT a test body: this graph costs several seconds to transform and
// a body-level `await import()` charges all of it to one test's timeout budget.
// At module scope it lands in Vitest's collection phase, which no timeout bounds.
import { createBuzzPurchaseTransactionHandler } from '~/server/controllers/paddle.controller';
import { getPaymentIntentHandler } from '~/server/controllers/stripe.controller';

const USER_ID = 90210;
const IP = '198.51.100.24';

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifyCaptchaToken.mockResolvedValue(true);
});

/** The arguments handed to `verifyCaptchaToken` by the single call under test. */
function soleCaptchaArgs(): Record<string, unknown> {
  expect(mockVerifyCaptchaToken).toHaveBeenCalledTimes(1);
  const [args] = mockVerifyCaptchaToken.mock.calls[0] as [Record<string, unknown>];
  return args;
}

/**
 * The `meta` object handed to `verifyCaptchaToken`, asserting alongside it that the
 * caller also forwarded `ip`.
 *
 * `ip` is checked here rather than in a separate test because it is the same class of
 * regression as a missing `meta` and was previously unpinned: dropping `ip: ctx.ip`
 * from a call site left the whole suite green, since the behavioural tests only ever
 * read `meta` and the ledger only required a `meta:` key.
 */
function soleCaptchaMeta(): Record<string, unknown> {
  const args = soleCaptchaArgs();
  // Named explicitly so this fails as "meta is missing" rather than as an
  // unhelpful "cannot read property of undefined" further down.
  expect(args).toHaveProperty('meta');
  expect(args.meta, 'verifyCaptchaToken was called without `meta`').toBeDefined();
  expect(args, 'verifyCaptchaToken was called without `ip`').toHaveProperty('ip');
  expect(args.ip, 'verifyCaptchaToken was called with an undefined `ip`').toBe(IP);
  return args.meta as Record<string, unknown>;
}

describe('paddle buzz-purchase call site', () => {
  it('passes a meta identifying the paddle purchase flow and the user', async () => {
    const ctx = { user: { id: USER_ID, email: 'buyer@example.com' }, ip: IP };
    const input = { recaptchaToken: 'tok_paddle_1234567890', unitAmount: 500 };

    await createBuzzPurchaseTransactionHandler({
      ctx,
      input,
    } as unknown as Parameters<typeof createBuzzPurchaseTransactionHandler>[0]);

    const meta = soleCaptchaMeta();
    expect(meta.source).toBe('paddle-buzz-purchase');
    expect(meta.userId).toBe(USER_ID);
    // The source must be distinguishable, not just present — an empty string or a
    // value shared with another flow would satisfy a bare presence check.
    expect(String(meta.source)).not.toHaveLength(0);
  });
});

describe('stripe payment-intent call site', () => {
  it('passes a meta identifying the stripe payment-intent flow and the user', async () => {
    const ctx = {
      user: { id: USER_ID, email: 'buyer@example.com', customerId: 'cus_test' },
      ip: IP,
    };
    const input = { recaptchaToken: 'tok_stripe_1234567890', unitAmount: 500 };

    await getPaymentIntentHandler({
      ctx,
      input,
    } as unknown as Parameters<typeof getPaymentIntentHandler>[0]);

    const meta = soleCaptchaMeta();
    expect(meta.source).toBe('stripe-payment-intent');
    expect(meta.userId).toBe(USER_ID);
    expect(String(meta.source)).not.toHaveLength(0);
  });
});

describe('the two payment flows are distinguishable from each other', () => {
  it('uses a different meta.source per flow', async () => {
    const base = { id: USER_ID, email: 'buyer@example.com', customerId: 'cus_test' };

    await createBuzzPurchaseTransactionHandler({
      ctx: { user: base, ip: IP },
      input: { recaptchaToken: 'tok_paddle_1234567890', unitAmount: 500 },
    } as unknown as Parameters<typeof createBuzzPurchaseTransactionHandler>[0]);
    const paddleMeta = soleCaptchaMeta();

    vi.clearAllMocks();
    mockVerifyCaptchaToken.mockResolvedValue(true);

    await getPaymentIntentHandler({
      ctx: { user: base, ip: IP },
      input: { recaptchaToken: 'tok_stripe_1234567890', unitAmount: 500 },
    } as unknown as Parameters<typeof getPaymentIntentHandler>[0]);
    const stripeMeta = soleCaptchaMeta();

    // The whole point of adding meta: an operator can tell the two apart.
    expect(paddleMeta.source).not.toBe(stripeMeta.source);
  });
});

describe('call-site ledger — every verifyCaptchaToken caller supplies meta', () => {
  const SRC = path.resolve(__dirname, '../../..');

  /**
   * The asserted set of call sites. Adding a caller is fine — but it must be
   * added here WITH a `meta`, which is the point: the ledger fails when the set
   * grows or shrinks, so a new caller cannot quietly ship without telemetry.
   */
  const EXPECTED_CALL_SITES = [
    'server/controllers/paddle.controller.ts',
    'server/controllers/stripe.controller.ts',
    'server/controllers/user.controller.ts',
  ].sort();

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        walk(full, out);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  const callSites = walk(SRC)
    .filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      // The invocation, not the import line.
      return /verifyCaptchaToken\s*\(/.test(text);
    })
    .map((file) => path.relative(SRC, file).replace(/\\/g, '/'))
    // The definition itself is not a call site.
    .filter((rel) => rel !== 'server/recaptcha/client.ts')
    .sort();

  /**
   * Does this call's argument object supply `name` with a real value?
   *
   * Matches at a PROPERTY position (`{` or `,` immediately before the key) in either
   * of the two ways the argument can legally be written:
   *
   *   - `name: <value>`, with a negative lookahead on `undefined` — a bare
   *     `/\bmeta\s*:/` is satisfied by `meta: undefined`, which passes nothing and
   *     defeats the whole ledger.
   *   - the ES6 SHORTHAND `{ token, ip, meta }` — the same argument written
   *     differently. The previous form required a literal `:` and so would have
   *     FALSE-FAILED a future call site that used shorthand, which is a gate going red
   *     on correct code: the fastest way to teach everyone to delete the gate.
   *
   * KNOWN LIMITATION — this is a regex over source text, not a parse:
   *
   *   - A key of the same name nested one level down (`meta: { source, ip }`) satisfies
   *     the check for `ip`. Anchoring to a property position removes the `ctx.ip`
   *     value-side false match but cannot see nesting depth.
   *   - Spread-supplied arguments (`verifyCaptchaToken({ ...args })`) are invisible to
   *     it entirely.
   *
   * Both are acceptable because this ledger is the SECOND guard, not the only one: the
   * behavioural tests above drive the real handlers and assert the values that actually
   * reach `verifyCaptchaToken`. The ledger exists solely to catch a NEW call site that
   * those tests structurally cannot see. If it ever needs to be exact, replace it with
   * a TypeScript AST walk rather than a longer regex.
   */
  const supplies = (name: string) =>
    new RegExp(`[{,]\\s*${name}\\b\\s*(?::\\s*(?!undefined\\b)\\S|[,}])`);

  it('finds exactly the known call sites (positive control on the scan)', () => {
    // Positive control: if the scan matched nothing, the per-site assertion below
    // would iterate an empty array and pass — a zero indistinguishable from a
    // harness wired to nothing.
    expect(callSites.length).toBeGreaterThan(0);
    expect(callSites).toEqual(EXPECTED_CALL_SITES);
  });

  it.each(EXPECTED_CALL_SITES)('%s passes meta and ip to verifyCaptchaToken', (rel) => {
    const text = fs.readFileSync(path.join(SRC, rel), 'utf8');

    // Slice each invocation's argument object and require `meta:` and `ip:` in it.
    const invocations = [...text.matchAll(/verifyCaptchaToken\s*\(\s*\{/g)].map((match) => {
      const start = match.index + match[0].length - 1;
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) return text.slice(start, i + 1);
        }
      }
      return text.slice(start);
    });

    expect(invocations.length).toBeGreaterThan(0);
    for (const args of invocations) {
      expect(args, `a verifyCaptchaToken call in ${rel} omits meta`).toMatch(supplies('meta'));
      expect(args, `a verifyCaptchaToken call in ${rel} omits ip`).toMatch(supplies('ip'));
    }
  });

  /**
   * The matcher is the ledger's whole verdict, so it gets its own cases rather than
   * being trusted because the three current call sites happen to pass it. Both
   * directions are represented: a matcher that always returned `true` would pass the
   * ledger above forever, and one that always returned `false` would look like a
   * real finding.
   */
  describe('the supplies() matcher', () => {
    it.each([
      ['{ token, ip, meta }', 'ip', 'shorthand, mid-object'],
      ['{ token, ip, meta }', 'meta', 'shorthand, last key'],
      ['{ token, meta, ip }', 'ip', 'shorthand, last key with no trailing comma'],
      ['{ token: t, secret: s, ip: ctx.ip, meta: { a: 1 } }', 'ip', 'explicit value'],
      ['{ token: t, ip: ctx.ip, meta: { source: "x", userId: 1 } }', 'meta', 'object value'],
    ])('accepts %s for `%s` (%s)', (src, name) => {
      expect(src).toMatch(supplies(name));
    });

    it.each([
      ['{ token: t, meta: undefined, ip: ctx.ip }', 'meta', 'explicit undefined'],
      ['{ token: t, ip: undefined }', 'ip', 'explicit undefined'],
      ['{ token: t }', 'meta', 'key absent entirely'],
      ['{ token: t, remoteip: ctx.ip }', 'ip', 'a longer key merely ENDING in the name'],
    ])('rejects %s for `%s` (%s)', (src, name) => {
      expect(src).not.toMatch(supplies(name));
    });
  });
});
