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
  lockedProperties: string[] | null;
  verdict: RestrictedNsfwVerdict | null;
  systemNsfwLock: RestrictedNsfwVerdictRulingRecord['prior']['systemNsfwLock'];
  rulings: RestrictedNsfwVerdictRulingRecord[] | null;
};

/** A model the owner once declared minor counts as minor here even after they untick it. */
const restrictionOf = (row: Row, verdict: RestrictedNsfwVerdict): Restriction =>
  row.minor || verdict.restriction === 'minor'
    ? 'minor'
    : row.poi || verdict.restriction === 'poi'
    ? 'poi'
    : 'sfwOnly';

/**
 * A moderator's ruling on a restricted-verdict lead: the text scan rated a minor, POI or SFW-only
 * model NSFW and left nsfw alone (`holdRestrictedVerdict`).
 * - `keep`: the owner's rating stands: nsfw off, and SFW-only back on where the scan cleared it. The
 *   scan's own lock for this lead is lifted; a moderator's lock (every moderator nsfw write drops the
 *   `systemNsfwLock` marker) or a newer scan's lock stands, and then nothing but the lead changes.
 * - `dismiss`: drops the lead only, after the moderator acted elsewhere. A minor lead needs a reason.
 * - `rateNsfw`: SFW-only leads only. Unsets sfwOnly, sets nsfw and locks it as the moderator's.
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
      SELECT m."userId", m.nsfw, m.minor, m.poi, m."sfwOnly", m."lockedProperties",
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
    if (ruling === 'rateNsfw' && restriction !== 'sfwOnly')
      throw throwBadRequestError(
        'This model is marked as depicting a real person or a minor; it cannot be rated NSFW.'
      );

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
      const nsfwLocked = locked.includes('nsfw');
      if (!nsfwLocked || lockIsLeads) {
        next = {
          nsfw: false,
          sfwOnly: verdict.applied?.prior.sfwOnly ?? row.sfwOnly,
          lockedProperties: lockIsLeads ? locked.filter((p) => p !== 'nsfw') : locked,
        };
        dropSystemLock = lockIsLeads;
      }
    } else if (ruling === 'rateNsfw') {
      next = {
        nsfw: true,
        sfwOnly: false,
        lockedProperties: locked.includes('nsfw') ? locked : [...locked, 'nsfw'],
      };
      dropSystemLock = true;
    }

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
    const dropped = dropSystemLock
      ? ['restrictedNsfwVerdict', 'systemNsfwLock']
      : ['restrictedNsfwVerdict'];
    // Guarded on the lead still being there: the row lock makes a second ruling wait, then fail here.
    const written = await tx.$executeRaw`
      UPDATE "Model" m
      SET nsfw = ${next.nsfw},
          "sfwOnly" = ${next.sfwOnly},
          "lockedProperties" = ${next.lockedProperties}::text[],
          meta = (m.meta - ${dropped}::text[])
            || jsonb_build_object('restrictedNsfwVerdictRulings', ${JSON.stringify(rulings)}::jsonb)
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
