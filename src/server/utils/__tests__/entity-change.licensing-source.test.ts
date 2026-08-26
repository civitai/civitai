import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { watchedEntityFields } from '~/server/common/entity-change.constants';
import { diffEntityChanges } from '~/server/utils/entity-change-helpers';

/**
 * The audit half of CU 868kwf2fd. `licensingSourceVersionId` decides who is paid per generated image
 * and by whom, and it changed with no trail at all — `entityChangeEvents` held zero rows for it against
 * 4,042 for `licensingFee` when this was written.
 *
 * 🔴 Every mechanism below fails SILENTLY when it breaks. A watched field missing from the service's
 * `before` select produces no row rather than an error; a mistyped `systemFields` key is a plain object
 * lookup that returns `undefined`; a field dropped from `watchedEntityFields` simply stops being
 * compared. None of them throws, so nothing but an assertion of the wired-up state can notice. Three
 * separate one-line deletions used to leave the whole suite green.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

const OWNER_ID = 5479411;
const VERSION_ID = 3144879;
const ANIMA_ROOT = 2945208;

const diff = (before: Record<string, unknown>, after: Record<string, unknown>, reason?: string) =>
  diffEntityChanges({
    entityType: 'ModelVersion',
    entityId: VERSION_ID,
    ownerId: OWNER_ID,
    before,
    after,
    actorRole: 'owner',
    systemFields: reason ? { licensingSourceVersionId: reason } : undefined,
  });

describe('licensingSourceVersionId — the settings audit', () => {
  it('is watched at all', () => {
    expect(watchedEntityFields.ModelVersion).toContain('licensingSourceVersionId');
  });

  it('records a creator clearing their own lineage', () => {
    const rows = diff({ licensingSourceVersionId: ANIMA_ROOT }, { licensingSourceVersionId: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      field: 'licensingSourceVersionId',
      oldValue: String(ANIMA_ROOT),
      newValue: 'null',
      actorRole: 'owner',
    });
  });

  // The rows this field's audit will mostly produce are the server's own repairs, and attributing
  // those to the creator is worse than the missing trail it replaces — the whole complaint was that
  // 160 versions carried a value nobody could account for.
  it('attributes a server-side coercion to the rule, not to the creator', () => {
    const rows = diff(
      { licensingSourceVersionId: ANIMA_ROOT },
      { licensingSourceVersionId: null },
      'model-type-mismatch'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorRole: 'system', reason: 'model-type-mismatch' });
  });

  // Partial writes are ordinary here — requestReviewHandler and declineReviewHandler send a few fields
  // — so an absent key must mean "untouched", never "cleared".
  it('emits nothing when the field is absent from the payload', () => {
    expect(diff({ licensingSourceVersionId: ANIMA_ROOT }, { name: 'v1.1' })).toHaveLength(0);
  });

  /**
   * The two tests below assert on the SERVICE'S SOURCE TEXT, which is a weaker instrument than driving
   * the code, and they are here because the alternative was nothing. `upsertModelVersion` reaches most
   * of the schema, so a behavioural test of its audit path is a large mock surface; the wiring it would
   * check is three lines that fail silently when broken. Measured before these existed: deleting the
   * select line, deleting the `systemFields` block, or misspelling its key each left the entire suite
   * green.
   *
   * If someone later writes the behavioural test, delete these rather than keeping both.
   */

  /**
   * 🔴 `diffEntityChanges` compares `before[field]` to `after[field]`, so a watched field the
   * service never selects is `undefined` on the before side and silently produces no row — the audit
   * reads as wired up and records nothing.
   *
   * Asserted over the whole watched list, because the next field added will have the same trap and
   * nobody will remember this test exists.
   */
  it('selects every watched ModelVersion column for the audit before-side', () => {
    // Not columns: these three are computed and set as explicit keys on the `before` literal instead
    // (`paidAccess` from its own read, `licensingFee` coerced off a Decimal, `monetization` reshaped).
    // Listed rather than pattern-matched so that adding a fourth is a deliberate edit here.
    const SUPPLIED_NOT_SELECTED = ['paidAccess', 'licensingFee', 'monetization'];

    const service = readFileSync(
      path.join(REPO_ROOT, 'src/server/services/model-version.service.ts'),
      'utf8'
    );
    const at = service.indexOf(
      'const existingVersion = await dbWrite.modelVersion.findUniqueOrThrow'
    );
    expect(
      at,
      'the upsert update-branch read moved; re-anchor this test, do not delete it'
    ).toBeGreaterThan(-1);
    const select = service.slice(at, service.indexOf('});', at));

    const missing = watchedEntityFields.ModelVersion.filter(
      (field) =>
        !SUPPLIED_NOT_SELECTED.includes(field.split('.')[0]) &&
        !new RegExp(`\\b${field.split('.')[0]}: (true|\\{)`).test(select)
    );
    expect(missing, `watched but not selected, so they audit nothing: ${missing}`).toEqual([]);
  });

  /**
   * 🔴 `systemFields` is read as `systemFields?.[field]` — a plain object lookup. A key that does
   * not match a watched field name returns `undefined`, so the row is still written and simply carries
   * the creator's name instead of the rule's. No error, no missing row, just wrong attribution on the
   * only field in this list that decides who gets paid.
   */
  it('attributes the licensing coercion under the exact watched field name', () => {
    const service = readFileSync(
      path.join(REPO_ROOT, 'src/server/services/model-version.service.ts'),
      'utf8'
    );
    const at = service.indexOf('systemFields:');
    expect(at, 'the upsert audit no longer passes systemFields at all').toBeGreaterThan(-1);
    const block = service.slice(at, at + 300);
    expect(block).toContain('licensingSourceVersionId:');
  });
});
