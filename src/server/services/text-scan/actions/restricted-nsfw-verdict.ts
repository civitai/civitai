import { Tracker } from '~/server/clickhouse/tracker';
import { preventReplicationLag } from '~/server/db/db-lag-helpers';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import type {
  ModelMeta,
  RestrictedNsfwVerdict,
  RestrictedNsfwVerdictRulingRecord,
} from '~/server/schema/model.schema';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { updateModelNsfwLevels } from '~/server/services/nsfwLevels.service';
import { diffEntityChanges } from '~/server/utils/entity-change-helpers';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { uniq } from 'lodash-es';

export const RESTRICTED_NSFW_VERDICT_RULINGS = [
  'keep',
  'dismiss',
  'rateNsfw',
] as const satisfies readonly RestrictedNsfwVerdictRulingRecord['ruling'][];
export type RestrictedNsfwVerdictRuling = (typeof RESTRICTED_NSFW_VERDICT_RULINGS)[number];

/** Rulings kept on the model, newest last: enough to undo the last few by hand. */
const RULINGS_KEPT = 5;

type Restriction = RestrictedNsfwVerdict['restriction'];

type Row = {
  userId: number;
  nsfw: boolean;
  minor: boolean;
  poi: boolean;
  sfwOnly: boolean;
  availability: string;
  lockedProperties: string[] | null;
  verdict: RestrictedNsfwVerdict | null;
  systemNsfwLock: RestrictedNsfwVerdictRulingRecord['prior']['systemNsfwLock'];
  rulings: RestrictedNsfwVerdictRulingRecord[] | null;
  ownerFlagOverride: ModelMeta['ownerFlagOverride'] | null;
  ownerDeclaredFlags: ModelMeta['ownerDeclaredFlags'] | null;
  minorFlagSnapshot: ModelMeta['minorFlagSnapshot'] | null;
};

/** A model the owner once declared minor counts as minor here even after they untick it: for the
 *  queue order and the reasons it needs, not for whether it may be rated NSFW. */
const restrictionOf = (row: Row, verdict: RestrictedNsfwVerdict): Restriction =>
  row.minor || verdict.restriction === 'minor'
    ? 'minor'
    : row.poi || verdict.restriction === 'poi'
    ? 'poi'
    : 'sfwOnly';

/**
 * A moderator's ruling on a lead the text scan left on a restricted model. A moderator's or a newer
 * scan's lock outlives Keep, and Keep on a model still minor or POI parks the verdict dormant, to come
 * back if the owner clears the flag.
 */
export async function resolveRestrictedNsfwVerdict({
  modelId,
  ruling,
  reason,
  userId,
}: {
  modelId: number;
  ruling: RestrictedNsfwVerdictRuling;
  reason?: string;
  userId: number;
}) {
  const note = reason?.trim() || null;
  const result = await dbWrite.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<Row[]>`
      SELECT m."userId", m.nsfw, m.minor, m.poi, m."sfwOnly", m.availability, m."lockedProperties",
        m.meta->'restrictedNsfwVerdict' AS verdict,
        m.meta->'systemNsfwLock' AS "systemNsfwLock",
        m.meta->'restrictedNsfwVerdictRulings' AS rulings,
        m.meta->'ownerFlagOverride' AS "ownerFlagOverride",
        m.meta->'ownerDeclaredFlags' AS "ownerDeclaredFlags",
        m.meta->'minorFlagSnapshot' AS "minorFlagSnapshot"
      FROM "Model" m
      WHERE m.id = ${modelId} AND jsonb_typeof(m.meta) = 'object'
      FOR UPDATE OF m
    `;
    const verdict = row?.verdict;
    if (!row || !verdict || typeof verdict !== 'object')
      throw throwBadRequestError('This lead was ruled on meanwhile; reload.');

    const restriction = restrictionOf(row, verdict);
    if (ruling === 'dismiss' && restriction === 'minor' && !note)
      throw throwBadRequestError('Say why a minor lead is dismissed, or where it was escalated.');
    // The owner form refuses to save nsfw with SFW-only, and a minor or POI model is never NSFW, so the
    // lead may not close on either.
    if (ruling === 'dismiss' && row.nsfw && (row.sfwOnly || row.minor || row.poi))
      throw throwBadRequestError("Keep or Rate NSFW: the model can't be saved as it is.");
    if (ruling === 'rateNsfw' && (row.minor || row.poi))
      throw throwBadRequestError(
        'This model is marked as depicting a real person or a minor; it cannot be rated NSFW.'
      );
    if (ruling === 'rateNsfw' && row.availability === 'Private')
      throw throwBadRequestError(
        'This model is private and stays SFW-only; the rating applies when it is published.'
      );
    if (ruling === 'rateNsfw' && restriction === 'minor' && !note)
      throw throwBadRequestError('Say why a model once marked minor is rated NSFW.');

    const locked = row.lockedProperties ?? [];
    const prior = {
      nsfw: row.nsfw,
      sfwOnly: row.sfwOnly,
      lockedProperties: locked,
      systemNsfwLock: row.systemNsfwLock ?? null,
    };
    let next = { nsfw: row.nsfw, sfwOnly: row.sfwOnly, lockedProperties: locked };
    let dropSystemLock = false;
    if (ruling === 'keep') {
      // Only the lock the scan set for this lead (or before it) is lifted: a moderator's lock, or a
      // newer scan's on a model the owner has since unrestricted, is a later call that stands.
      const leadAt = Date.parse(verdict.applied?.at ?? verdict.at);
      const lockAt = Date.parse(row.systemNsfwLock?.at ?? '');
      const lockIsLeads = !!row.systemNsfwLock && lockAt <= leadAt;
      const sfwOnly = verdict.applied?.prior.sfwOnly ?? row.sfwOnly;
      if (verdict.applied && (row.minor || row.poi)) {
        // Re-ticked since the scan applied: the flag holds the rating now, and its locks stand.
        next = { nsfw: false, sfwOnly: row.sfwOnly, lockedProperties: locked };
      } else if (lockIsLeads) {
        next = { nsfw: false, sfwOnly, lockedProperties: locked.filter((p) => p !== 'nsfw') };
        dropSystemLock = true;
      } else if (!locked.includes('nsfw')) {
        // Nothing of the scan's to undo: an owner who has since unrestricted the model and rated it
        // NSFW keeps that rating.
        next = {
          nsfw: row.minor || row.poi || sfwOnly ? false : row.nsfw,
          sfwOnly,
          lockedProperties: locked,
        };
      }
      // A minor or POI model ends SFW whatever lock it carries (one whose time can't be read, say).
      if (row.minor || row.poi) next = { ...next, nsfw: false };
    } else if (ruling === 'rateNsfw') {
      next = {
        nsfw: true,
        sfwOnly: false,
        lockedProperties: locked.includes('nsfw') ? locked : [...locked, 'nsfw'],
      };
      dropSystemLock = true;
    }
    // A Keep on a model still minor or POI rules on the rating the flag holds, not on the scan: the
    // verdict waits, server-owned, and comes back as a held lead if the owner clears the flag.
    const dormant: RestrictedNsfwVerdict | null =
      ruling === 'keep' && (row.minor || row.poi)
        ? { source: verdict.source, at: verdict.at, restriction: verdict.restriction }
        : null;

    const record: RestrictedNsfwVerdictRulingRecord = {
      at: new Date().toISOString(),
      by: userId,
      ruling,
      restriction,
      reason: note,
      verdict,
      prior,
    };
    const rulings = [...(Array.isArray(row.rulings) ? row.rulings : []), record].slice(
      -RULINGS_KEPT
    );
    const dropped = [
      'restrictedNsfwVerdict',
      'restrictedNsfwVerdictDormant',
      ...(dropSystemLock ? ['systemNsfwLock'] : []),
      // The owner's flag cleared a scan's rating and kept it to restore when the flag lifts: a Keep or
      // Dismiss has ruled on that rating, so a later lift must not bring it back.
      ...(ruling === 'rateNsfw' ? [] : ['ownerFlagOverride']),
    ];
    // The override goes, but the minor-hash rollback still has to know the owner declared the flag.
    const dropsOverride = ruling !== 'rateNsfw' && !!row.ownerFlagOverride;
    const declared: Pick<ModelMeta, 'ownerDeclaredFlags'> =
      dropsOverride && row.ownerFlagOverride
        ? {
            ownerDeclaredFlags: {
              at: row.ownerDeclaredFlags?.at ?? row.ownerFlagOverride.at,
              flags: uniq([
                ...(row.ownerDeclaredFlags?.flags ?? []),
                ...row.ownerFlagOverride.flags,
              ]),
            },
          }
        : {};
    // A minor flag set after the scan applied snapshotted the scan's rating as the one its lift
    // restores. A Keep has ruled that rating out, so the snapshot no longer describes it.
    const snapshot = row.minorFlagSnapshot;
    const supersedesSnapshot =
      ruling === 'keep' &&
      !!verdict.applied &&
      !!snapshot?.at &&
      !snapshot.supersededAt &&
      Date.parse(snapshot.at) >= Date.parse(verdict.applied.at);
    const superseded: Pick<ModelMeta, 'minorFlagSnapshot'> =
      supersedesSnapshot && snapshot
        ? { minorFlagSnapshot: { ...snapshot, supersededAt: new Date().toISOString() } }
        : {};
    // Guarded on the lead still being there: the row lock makes a second ruling wait, then fail here.
    const written = await tx.$executeRaw`
      UPDATE "Model" m
      SET nsfw = ${next.nsfw},
          "sfwOnly" = ${next.sfwOnly},
          "lockedProperties" = ${next.lockedProperties}::text[],
          meta = (m.meta - ${dropped}::text[])
            || jsonb_build_object('restrictedNsfwVerdictRulings', ${JSON.stringify(rulings)}::jsonb)
            || ${JSON.stringify(dormant ? { restrictedNsfwVerdictDormant: dormant } : {})}::jsonb
            || ${JSON.stringify(declared)}::jsonb
            || ${JSON.stringify(superseded)}::jsonb
      WHERE m.id = ${modelId} AND m.meta ? 'restrictedNsfwVerdict'
    `;
    if (!written) throw throwBadRequestError('This lead was ruled on meanwhile; reload.');

    await trackModActivity(
      userId,
      { entityType: 'model', entityId: modelId, activity: `restrictedNsfwVerdict:${ruling}` },
      tx
    );
    return { row, prior, next, restriction };
  });

  const { row, prior, next, restriction } = result;
  const changed = prior.nsfw !== next.nsfw || prior.sfwOnly !== next.sfwOnly;
  if (changed) {
    // The ruling is committed and its lead is gone, so nothing retries these and no failure here may
    // read as a failed ruling. A level left stale can under-rate the model, so that failure is logged.
    try {
      await updateModelNsfwLevels([modelId]);
    } catch (error) {
      logToAxiom({
        name: 'restricted-nsfw-verdict',
        type: 'error',
        message: 'ruling committed but the model nsfwLevel was not recomputed',
        modelId,
        ruling,
        error: (error as Error).message,
      });
    }
    await preventReplicationLag('model', modelId).catch(() => null);
    await bustPublicModelResponseCache(modelId).catch(() => null);
    await new Tracker()
      .entityChanges(
        diffEntityChanges({
          entityType: 'Model',
          entityId: modelId,
          ownerId: row.userId,
          before: {
            nsfw: prior.nsfw,
            sfwOnly: prior.sfwOnly,
            lockedProperties: prior.lockedProperties,
          },
          after: next,
          actorRole: 'moderator',
        })
      )
      .catch(() => null);
  }
  return { modelId, ruling, restriction, nsfw: next.nsfw, sfwOnly: next.sfwOnly };
}
