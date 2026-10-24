import { describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
import { coverageFilter, versionGeneratableFor } from '~/shared/generation/coverage-fields';

const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt: mockIsFlipt,
}));

const { coverageAudience, coveredForUser, coveredForUserSql } = await import(
  '~/server/services/generation/coverage-source'
);

/**
 * Non-members generate from `covered` plus anything already resident; members also get the
 * `coveredNext` expansion. Every case below is one cell of that table, and the two halves — the
 * database columns and the indexed pair the picker reads — are asserted against the same cells so
 * they cannot answer differently for the same version.
 */

const CKPT = { isCheckpoint: true };
const LORA = { isCheckpoint: false };

/** In the expansion only: `coveredNext` without `covered`. */
const expansion = (over: Record<string, unknown> = {}) => ({
  covered: false,
  coveredNext: true,
  ...over,
});
const live = { covered: true, coveredNext: true };

describe('coveredForUser — the database columns', () => {
  it('gives a member the expansion', () => {
    expect(coveredForUser(expansion(), true, { member: true, ...CKPT })).toBe(true);
  });

  it('refuses a non-member an expansion checkpoint that is cold', () => {
    expect(coveredForUser(expansion(), true, { member: false, ...CKPT })).toBe(false);
  });

  it('allows a non-member an expansion checkpoint that is already resident', () => {
    expect(
      coveredForUser(expansion({ generatorLoaded: true }), true, { member: false, ...CKPT })
    ).toBe(true);
  });

  /**
   * The two sets the live rule is built from — ecosystem checkpoints and auction winners. Every
   * one of them is `covered`, so this is the case that must never be gated: an auction winner was
   * already paid for, and gating it would charge twice for the same thing.
   */
  it('always allows a non-member a checkpoint the live rule covers, cold or not', () => {
    expect(coveredForUser(live, true, { member: false, ...CKPT })).toBe(true);
    expect(
      coveredForUser({ ...live, generatorLoaded: false }, true, { member: false, ...CKPT })
    ).toBe(true);
  });

  /**
   * For a non-checkpoint the expansion is file-format support — `coveredNext` accepts Diffusers
   * where `covered` does not — so gating it would charge for a format fix rather than a download.
   */
  it('leaves the non-checkpoint half of the expansion open to everyone', () => {
    expect(coveredForUser(expansion(), true, { member: false, ...LORA })).toBe(true);
  });

  it('reads residency through the readiness helper, so an API checkpoint is not gated', () => {
    expect(
      coveredForUser(expansion({ usageControl: 'ExternalGeneration' }), true, {
        member: false,
        ...CKPT,
      })
    ).toBe(true);
  });

  it('ignores the audience entirely while the expansion is off', () => {
    expect(coveredForUser(expansion(), false, { member: false, ...CKPT })).toBe(false);
    expect(coveredForUser(live, false, { member: false, ...CKPT })).toBe(true);
  });

  it('keeps null for a version with no coverage row', () => {
    expect(coveredForUser(null, true, { member: false, ...CKPT })).toBe(null);
  });
});

describe('versionGeneratableFor — the indexed pair, same cells', () => {
  const idx = (over: Record<string, unknown> = {}) => ({
    canGenerate: false,
    canGenerateNext: true,
    ...over,
  });

  it('gives a member the expansion', () => {
    expect(versionGeneratableFor(idx(), { coverageNext: true, member: true, ...CKPT })).toBe(true);
  });

  it('refuses a non-member a cold expansion checkpoint', () => {
    expect(versionGeneratableFor(idx(), { coverageNext: true, member: false, ...CKPT })).toBe(
      false
    );
  });

  it('allows a non-member a resident one', () => {
    expect(
      versionGeneratableFor(idx({ generatorLoaded: true }), {
        coverageNext: true,
        member: false,
        ...CKPT,
      })
    ).toBe(true);
  });

  it('leaves the live set and the non-checkpoint half open', () => {
    expect(
      versionGeneratableFor(idx({ canGenerate: true }), {
        coverageNext: true,
        member: false,
        ...CKPT,
      })
    ).toBe(true);
    expect(versionGeneratableFor(idx(), { coverageNext: true, member: false, ...LORA })).toBe(true);
  });
});

describe('coverageAudience — how the two flags compose', () => {
  const flags = (coverageNext: boolean, openToAll: boolean) =>
    mockIsFlipt.mockImplementation(async (flag: string) =>
      flag === 'generation-coverage-next' ? coverageNext : openToAll
    );

  it('never asks about membership while the expansion is off', async () => {
    flags(false, false);
    await expect(coverageAudience({ id: 7, tier: 'free' })).resolves.toEqual({
      next: false,
      member: true,
    });
    expect(mockIsFlipt).toHaveBeenCalledTimes(1);
  });

  it('gives a paying tier the expansion', async () => {
    flags(true, false);
    await expect(coverageAudience({ id: 7, tier: 'gold' })).resolves.toEqual({
      next: true,
      member: true,
    });
  });

  it('withholds it from a free tier, and from an absent one', async () => {
    flags(true, false);
    await expect(coverageAudience({ id: 7, tier: 'free' })).resolves.toMatchObject({
      member: false,
    });
    await expect(coverageAudience({ id: 7 })).resolves.toMatchObject({ member: false });
    await expect(coverageAudience()).resolves.toMatchObject({ member: false });
  });

  /**
   * `isGatedFor.members` in gates.ts reads `!isMember && !isModerator` — mods keep member access
   * whatever their tier. Leaving them out here made a moderator unable to see the very thing they
   * were asked to test, and it disagreed with the gate one file away.
   */
  it('gives a moderator the expansion whatever their tier', async () => {
    flags(true, false);
    await expect(
      coverageAudience({ id: 7, tier: 'free', isModerator: true })
    ).resolves.toMatchObject({ member: true });
  });

  it('opens it to a free tier once the rollout flag says so', async () => {
    flags(true, true);
    await expect(coverageAudience({ id: 7, tier: 'free' })).resolves.toMatchObject({
      member: true,
    });
  });

  /**
   * A percentage rollout hashes the entity id, so passing none makes it answer the same for every
   * user — the ramp silently becomes all-or-nothing. Nothing else observes this argument.
   */
  it('keys the rollout flag on the user id', async () => {
    flags(true, false);
    await coverageAudience({ id: 7, tier: 'free' });
    expect(mockIsFlipt).toHaveBeenCalledWith('generation-loading-open-to-all', '7');
  });
});

describe('coveredForUserSql — the same rule as a predicate', () => {
  /**
   * The EMITTED statement, normalised — not the template fragments. Joining `strings` hides what
   * the parentheses and the boolean operators do: swapping the inner ORs for ANDs, or dropping the
   * outer parens so a caller's own WHERE binds to the wrong branch, both leave a fragment
   * assertion green.
   */
  const sqlOf = (q: { sql: string }) => q.sql.replace(/\s+/g, ' ').trim();

  it('is the plain column for a member, and for the expansion being off', () => {
    expect(sqlOf(coveredForUserSql({ next: true, member: true }))).toContain('"coveredNext"');
    expect(sqlOf(coveredForUserSql({ next: true, member: true }))).not.toMatch(/\bOR\b/);
    expect(sqlOf(coveredForUserSql({ next: false, member: false }))).toContain('"covered"');
  });

  it('widens to the live rule plus a ready checkpoint for a non-member', () => {
    const sql = sqlOf(coveredForUserSql({ next: true, member: false }));
    expect(sql).toContain(
      `( "GenerationCoverage"."covered" OR ( "GenerationCoverage"."coveredNext" AND EXISTS ( ` +
        `SELECT 1 FROM "ModelVersion" mv_cov JOIN "Model" m_cov ON m_cov.id = mv_cov."modelId" ` +
        `WHERE mv_cov.id = "GenerationCoverage"."modelVersionId" AND ( ` +
        `m_cov.type <> 'Checkpoint'::"ModelType" OR mv_cov."generatorLoaded" OR ` +
        `mv_cov."usageControl" = 'ExternalGeneration'::"ModelUsageControl" ) ) ) )`
    );
  });

  /**
   * The alias argument has one production caller and, before this, no test — hardcoding the table
   * name inside it emits a reference the caller's FROM never declares, and Postgres answers
   * "missing FROM-clause entry": a 500 on every call.
   */
  it('honours a caller-supplied alias throughout', () => {
    const sql = sqlOf(coveredForUserSql({ next: true, member: false }, 'gc'));
    expect(sql).toContain('gc."covered"');
    expect(sql).toContain('gc."coveredNext"');
    expect(sql).toContain('mv_cov.id = gc."modelVersionId"');
    expect(sql).not.toContain('"GenerationCoverage"');
  });
});

describe('coverageFilter — the Meili form of the same rule', () => {
  it('is the plain field for a member, and while the expansion is off', () => {
    expect(coverageFilter({ canGenerate: true, coverageNext: true, member: true })).toBe(
      'canGenerateNext = true'
    );
    expect(coverageFilter({ canGenerate: true, coverageNext: false, member: false })).toBe(
      'canGenerate = true'
    );
  });

  it('widens to the live field OR a resident expansion version for a non-member', () => {
    const filter = coverageFilter({ canGenerate: true, coverageNext: true, member: false });
    expect(filter).toContain('canGenerate = true');
    expect(filter).toContain('canGenerateNext = true');
    expect(filter).toContain('versions.generatorLoaded = true');
    expect(filter).toContain(' OR ');
  });

  /**
   * A page can mix types, so the residency arm has to be scoped per row. Without the type escape a
   * non-member's LoRA picker loses the whole non-checkpoint expansion — versions this rule exempts,
   * and which no client-side widening can recover once Meili has filtered them out.
   */
  it('exempts non-checkpoints from the residency arm', () => {
    const filter = coverageFilter({ canGenerate: true, coverageNext: true, member: false });
    expect(filter).toContain('type != "Checkpoint"');
  });

  /** The client treats `canGenerate: false` as no filter, so widening it would filter against nothing. */
  it('leaves the false and absent cases exactly as they were', () => {
    expect(coverageFilter({ canGenerate: false, coverageNext: true, member: false })).toBe(
      'canGenerateNext = false'
    );
    expect(coverageFilter({ coverageNext: true, member: false })).toBe(null);
  });
});
