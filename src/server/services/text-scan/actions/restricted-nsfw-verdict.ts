import { Tracker } from '~/server/clickhouse/tracker';
import { preventReplicationLag } from '~/server/db/db-lag-helpers';
import { dbWrite } from '~/server/db/client';
import type {
  RestrictedNsfwVerdict,
  RestrictedNsfwVerdictRulingRecord,
} from '~/server/schema/model.schema';
import { bustPublicModelResponseCache } from '~/server/services/model-version.service';
import { trackModActivity } from '~/server/services/moderator.service';
import { updateModelNsfwLevels } from '~/server/services/nsfwLevels.service';
import { diffEntityChanges } from '~/server/utils/entity-change-helpers';
import { throwBadRequestError } from '~/server/utils/errorHandling';

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
 * A moderator's ruling on a restricted-verdict lead: the text scan rated a restricted model NSFW and
 * held the verdict (`holdRestrictedVerdict`), or rated an SFW-only model and recorded what it replaced.
 * - `keep`: the owner's rating stands: nsfw off, and SFW-only back on where the scan cleared it. The
 *   scan's own lock for this lead is lifted; a moderator's lock (every moderator nsfw write drops the
 *   `systemNsfwLock` marker) or a newer scan's lock stands, and then nothing but the lead changes. On a
 *   model still minor or POI the verdict is kept dormant, to come back if the owner clears the flag.
 * - `dismiss`: drops the lead only: the moderator judged the scan wrong, or acted elsewhere. A minor
 *   lead needs a reason. Refused on a model left NSFW and SFW-only, which its owner cannot save.
 * - `rateNsfw`: only while the model is neither minor, POI nor Private, and with a reason on a minor
 *   lead. Unsets sfwOnly, sets nsfw and locks it as the moderator's.
 * Each ruling closes the lead, logs a ModActivity row, and appends a record with the prior values.
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
        m.meta->'restrictedNsfwVerdictRulings' AS rulings
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
    // The owner form refuses to save nsfw with SFW-only, so the lead may not close on that pair.
    if (ruling === 'dismiss' && row.nsfw && row.sfwOnly)
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
    ];
    // Guarded on the lead still being there: the row lock makes a second ruling wait, then fail here.
    const written = await tx.$executeRaw`
      UPDATE "Model" m
      SET nsfw = ${next.nsfw},
          "sfwOnly" = ${next.sfwOnly},
          "lockedProperties" = ${next.lockedProperties}::text[],
          meta = (m.meta - ${dropped}::text[])
            || jsonb_build_object('restrictedNsfwVerdictRulings', ${JSON.stringify(rulings)}::jsonb)
            || ${JSON.stringify(dormant ? { restrictedNsfwVerdictDormant: dormant } : {})}::jsonb
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
    // The ruling is committed and its lead is gone, so nothing retries these: the level comes first,
    // and a failure in the rest must not stop it or read as a failed ruling.
    await updateModelNsfwLevels([modelId]);
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
