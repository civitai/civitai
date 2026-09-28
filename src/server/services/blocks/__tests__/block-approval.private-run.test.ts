import { beforeEach, describe, expect, it } from 'vitest';

/**
 * THE APPROVED-STATUS EXEMPTION FOR A PRIVATE RUN — `private_run_exempt`.
 *
 * [REG]. The verdict does not exist at `f7f5eb4996`; there, a private-run token on a
 * suspended app resolves `not_approved` and every block REST route and tRPC bridge proc
 * refuses it with a 403.
 *
 * 🔴 WHY THIS IS THE MOST IMPORTANT FILE IN THE FEATURE TO GET RIGHT. Without the
 * exemption the feature is INERT — the iframe boots, the handshake completes, and then
 * every single bridge call 403s, so the app renders and does nothing. With the
 * exemption too WIDE, a signed claim becomes a general status bypass on apps the
 * platform has taken down. The pair-keying is the whole of the difference, and it is
 * the property this file exists to pin.
 */

// 🔴 THE CANONICAL db MOCK — see `no-direct-shared-module-mock`. A hand-rolled partial
// mock of `~/server/db/client` is cached per WORKER under `--no-isolate` and poisons
// later files through shared source modules, sometimes silently (the victim collects
// zero tests and the summary still reads green).
//
// ⚠️ THE PREVIOUS HAND-WRITTEN MOCK ALIASED `dbRead` AND `dbWrite` TO ONE OBJECT, which
// the codemod refused to convert and rightly so: `resolveAppBlockApprovalVerdict` reads
// `dbRead` ONLY, and an alias would have let a `dbWrite` stub satisfy it. Naming the
// client this predicate actually exercises is the point.
import { dbMock } from '~/__tests__/mocks/db.mock';
const mockDb = dbMock.dbRead;

const { resolveAppBlockApprovalVerdict } = await import(
  '~/server/services/blocks/block-approval.service'
);

const APP_ID = 'app_privrun';
const BLOCK_ID = 'seed-explorer-fixture';
const APP_BLOCK_ID = 'apb_privrun';

/** Minimal verified-claims shape the predicate reads. */
function claims(over: Record<string, unknown> = {}) {
  return {
    sub: 'user:7001',
    appId: APP_ID,
    blockId: BLOCK_ID,
    appBlockId: APP_BLOCK_ID,
    blockInstanceId: `page_${APP_BLOCK_ID}`,
    scopes: [],
    ...over,
  } as never;
}

beforeEach(() => {
  mockDb.appBlock.findUnique.mockReset();
  mockDb.oauthClient.findUnique.mockReset();
  // The default fixture is the headline case: a SUSPENDED backing row really exists.
  mockDb.appBlock.findUnique.mockResolvedValue({ status: 'suspended' });
});

describe('resolveAppBlockApprovalVerdict — the private-run arm [REG]', () => {
  it('privateRun + a recognised audience → private_run_exempt, for all three audiences', async () => {
    for (const audience of ['owner', 'editor', 'moderator'] as const) {
      const verdict = await resolveAppBlockApprovalVerdict(
        claims({ privateRun: true, privateRunAudience: audience })
      );
      expect(verdict, `audience=${audience}`).toBe('private_run_exempt');
    }
  });

  it('🔴 answered BEFORE the row read — the status is irrelevant by construction', async () => {
    // The point of the population is that the status is NOT approved, so the answer
    // cannot depend on reading it. Asserted by the spy, not by the value: this is also
    // what makes the arm correct for a `deprecated` or `pending` row without a second
    // branch per status.
    mockDb.appBlock.findUnique.mockClear();
    await resolveAppBlockApprovalVerdict(
      claims({ privateRun: true, privateRunAudience: 'moderator' })
    );
    expect(mockDb.appBlock.findUnique).not.toHaveBeenCalled();
  });

  it('🔴 privateRun ALONE (no audience) is NOT exempt — the pair is the guard', async () => {
    // A one-bit status bypass is what this keying exists to prevent. The signer refuses
    // to produce this shape and the verifier refuses to accept it, so reaching the
    // predicate with it should be impossible — which is exactly why the predicate must
    // still refuse, rather than trusting two upstream layers.
    const verdict = await resolveAppBlockApprovalVerdict(claims({ privateRun: true }));
    expect(verdict).toBe('not_approved');
  });

  it('🔴 an UNRECOGNISED audience is NOT exempt (closed-set test, not typeof-string)', async () => {
    // The failure direction that matters: an unrecognised string is not `'editor'`, so
    // it would sail past the editor read-only belt with owner/moderator power. Refusing
    // it here means every downstream `=== 'editor'` test runs over three known values.
    for (const bogus of ['Editor', 'admin', '', 'OWNER', 'moderator ', 'owner\n']) {
      const verdict = await resolveAppBlockApprovalVerdict(
        claims({ privateRun: true, privateRunAudience: bogus })
      );
      expect(verdict, `audience=${JSON.stringify(bogus)}`).toBe('not_approved');
    }
  });

  it('an audience WITHOUT privateRun is not exempt either', async () => {
    const verdict = await resolveAppBlockApprovalVerdict(
      claims({ privateRunAudience: 'moderator' })
    );
    expect(verdict).toBe('not_approved');
  });

  it('🔴 NOT paired with `dev` — the pair our signer CANNOT produce must not be required', async () => {
    // The trap: the sibling review-sandbox exemption is keyed `dev && reviewRunForReal`,
    // so copying that shape here is the obvious move. It would make this exemption
    // UNREACHABLE for every token the signer can emit, because the signer THROWS on
    // `privateRun && dev` — a guard that can only ever be observed returning false.
    // This asserts the exemption holds WITHOUT `dev`, which is the only reachable shape.
    const verdict = await resolveAppBlockApprovalVerdict(
      claims({ privateRun: true, privateRunAudience: 'owner' })
    );
    expect(verdict).toBe('private_run_exempt');
  });
});

describe('the private-run arm does not disturb the existing populations [INV]', () => {
  it('an APPROVED app still answers ok', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
    expect(await resolveAppBlockApprovalVerdict(claims())).toBe('ok');
  });

  it('a plain (non-private-run) token on a SUSPENDED app still answers not_approved', async () => {
    // The regression this feature most needs to not cause: the ordinary refusal must
    // survive untouched, or the exemption has become a general bypass.
    expect(await resolveAppBlockApprovalVerdict(claims())).toBe('not_approved');
  });

  it('the review-sandbox pair still answers dev_exempt, and is NOT relabelled', async () => {
    // Folding the two exemptions into one verdict would make the operator-facing
    // counter unable to distinguish "authors dogfooding" from "somebody is running
    // taken-down apps". They must stay separate values.
    const verdict = await resolveAppBlockApprovalVerdict(
      claims({ dev: true, reviewRunForReal: true })
    );
    expect(verdict).toBe('dev_exempt');
    expect(verdict).not.toBe('private_run_exempt');
  });

  it('a missing backing row still answers not_found for a non-dev token', async () => {
    mockDb.appBlock.findUnique.mockResolvedValue(null);
    expect(await resolveAppBlockApprovalVerdict(claims())).toBe('not_found');
  });

  it('🔴 POSITIVE CONTROL: four claim shapes produce four DISTINCT verdicts', async () => {
    // Without this, a harness in which every call resolved the same string would make
    // every assertion above individually plausible and collectively vacuous — and a
    // uniformly-equal green is indistinguishable from a probe wired to nothing. This
    // drives the four shapes through the REAL predicate in one test and asserts the
    // answers are pairwise distinct, so the instrument is proven able to differentiate
    // before any of its verdicts is believed.
    mockDb.appBlock.findUnique.mockResolvedValue({ status: 'suspended' });
    const suspendedPlain = await resolveAppBlockApprovalVerdict(claims());
    const privateRun = await resolveAppBlockApprovalVerdict(
      claims({ privateRun: true, privateRunAudience: 'owner' })
    );
    const reviewSandbox = await resolveAppBlockApprovalVerdict(
      claims({ dev: true, reviewRunForReal: true })
    );
    mockDb.appBlock.findUnique.mockResolvedValue({ status: 'approved' });
    const approved = await resolveAppBlockApprovalVerdict(claims());

    const observed = [suspendedPlain, privateRun, reviewSandbox, approved];
    expect(observed).toEqual(['not_approved', 'private_run_exempt', 'dev_exempt', 'ok']);
    expect(new Set(observed).size, 'the four verdicts must be pairwise distinct').toBe(4);
  });
});
