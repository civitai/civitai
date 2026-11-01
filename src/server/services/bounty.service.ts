import { bountyThreadParents, detachHeldThreadsCte } from '~/server/services/comment-thread-hold';
import { holdMarkerViewExists, ownerHeldSql } from '~/server/services/legal-hold.service';
import { isRemovedWithOwner, notRemovedWithOwnerSql } from '~/server/utils/legal-hold';
import { asJsonbObjectSql } from '~/server/utils/jsonb-object';
import { heldEntryOnBountySql } from '~/server/services/held-review.service';
import type * as z from 'zod';
import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import {
  Availability,
  BountyEntryMode,
  Currency,
  ImageIngestionStatus,
  MetricTimeframe,
  TagTarget,
} from '~/shared/utils/prisma/enums';
import type { ManipulateType } from 'dayjs';
import dayjs from '~/shared/utils/dayjs';
import { groupBy, uniq } from 'lodash-es';
import { bountyRefundedEmail } from '~/server/email/templates';
import {
  TransactionType,
  type BuzzAccountType,
  type BuzzSpendType,
} from '~/shared/constants/buzz.constants';
import {
  createBuzzTransaction,
  createBuzzTransactionMany,
  createMultiAccountBuzzTransaction,
  getMultiAccountTransactionsByPrefix,
  getUserBuzzAccount,
  refundTransaction,
} from '~/server/services/buzz.service';
import { refundAllLegsByPrefix } from '~/server/services/buzz-prefix-refund';
import { getBuzzApiStatus } from '~/server/utils/buzz-error';
import {
  BOUNTY_AWARD_RESOLVED_ACTIVITY,
  BOUNTY_AWARD_UNPAID_ACTIVITY,
  BOUNTY_PAYOUT_RETRY_AFTER_MS,
  bountyUnpaidAwardTableExists,
  type BountyAwardRuling,
  isPayoutOverdue,
  isPayoutPending,
  lockBountyForPayout,
  nextPayoutRecordedAt,
  openUnpaidBountyAwardSql,
  payoutPendingSql,
} from '~/server/services/bounty-payout-lock';
import { assertBountyStarted } from '~/server/services/bounty-schedule';
import { bountyVisibilityWhere, type BountyViewer } from '~/server/services/bounty-visibility';
import {
  hasOpenTextScanFlag,
  readTextScanFlags,
  withTextScanDecision,
} from '~/server/services/text-scan/flag-snapshot';
import {
  checkEntityImageKeys,
  createEntityImages,
  updateEntityImages,
  enqueueImageIngestion,
} from '~/server/services/image.service';
import { decreaseDate, startOfDay } from '~/utils/date-helpers';
import type { NsfwLevel } from '../common/enums';
import { BountySort, BountyStatus } from '../common/enums';
import { dbRead, dbWrite } from '../db/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import type { GetByIdInput } from '../schema/base.schema';
import type {
  AddBenefactorUnitAmountInputSchema,
  BountyDetailsSchema,
  CreateBountyInput,
  GetInfiniteBountySchema,
  UpdateBountyInput,
  UpsertBountyInput,
} from '../schema/bounty.schema';
import { createBountyInputSchema, updateBountyInputSchema } from '../schema/bounty.schema';
import { isNotTag, isTag } from '../schema/tag.schema';
import { imageSelect } from '../selectors/image.selector';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwInsufficientFundsError,
  throwNotFoundError,
} from '../utils/errorHandling';
import { enforceLockedProperties } from '~/server/utils/locked-properties';
import { updateEntityFiles } from './file.service';
import type { ImageMetadata, VideoMetadata } from '~/server/schema/media.schema';
import type { IngestImageInput } from '~/server/schema/image.schema';
import { userBountyCountCache } from '~/server/redis/caches';
import { evaluateAutoNsfw } from '~/server/services/auto-nsfw';
import { legacyProfanityAutoNsfwApplies } from '~/server/services/text-scan/route';
import { scanEntityInBackground } from '~/server/services/text-scan/submit';
import { throwOnBlockedUserContent } from '~/server/services/blocklist.service';
import { newTagNames } from '~/server/services/new-tag-names';
import type { BlurbUse } from '~/server/services/blurb-materialize.service';
import {
  expandBlurbs,
  getReferencedBlurbIds,
  reconcileBlurbReferences,
} from '~/server/services/blurb-materialize.service';
import { SearchIndexUpdate } from '~/server/search-index/SearchIndexUpdate';
import { BOUNTIES_SEARCH_INDEX } from '~/server/common/constants';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { createProfanityFilter } from '~/libs/profanity-simple';
import { logToAxiom } from '~/server/logging/client';

export const getBountyTransactionPrefix = (bountyId: number, userId: number) => {
  return `bounty-${bountyId}-${userId}-${new Date().getTime()}`;
};

export const isBountyTransactionPrefix = (prefix: string) => {
  return prefix.startsWith('bounty-') && prefix.split('-').length >= 4;
};

export const getAllBounties = <TSelect extends Prisma.BountySelect>({
  input: {
    cursor,
    limit: take,
    query,
    sort,
    types,
    status,
    mode,
    engagement,
    userId,
    period,
    baseModels,
    excludedUserIds,
  },
  select,
  viewer,
}: {
  input: GetInfiniteBountySchema;
  select: TSelect;
  viewer?: BountyViewer;
}) => {
  const AND: Prisma.Enumerable<Prisma.BountyWhereInput> = [bountyVisibilityWhere(viewer)];

  if (userId && engagement) {
    if (engagement === 'favorite')
      AND.push({ engagements: { some: { type: 'Favorite', userId } } });
    if (engagement === 'tracking') AND.push({ engagements: { some: { type: 'Track', userId } } });
    if (engagement === 'supporter') AND.push({ benefactors: { some: { userId } } });
    if (engagement === 'awarded') AND.push({ benefactors: { some: { awartedTo: { userId } } } });
    if (engagement === 'active') AND.push({ entries: { some: { userId } } });
  }

  if (baseModels && baseModels.length) {
    AND.push({
      OR: baseModels.map((base) => ({ details: { path: ['baseModel'], equals: base } })),
    });
  }

  if (status) {
    if (status === BountyStatus.Open)
      AND.push({ complete: false, refunded: false, expiresAt: { gt: new Date() } });
    else if (status === BountyStatus.Awarded)
      AND.push({ complete: true, entries: { some: {} }, refunded: false });
    else if (status === BountyStatus.Expired) {
      // 1. return refunded ones expired
      // 3. return finished (expired) but not completed yet (48hr period).
      // 2. return completed no entries.
      const OR: Prisma.BountyWhereInput[] = [
        { expiresAt: { lt: new Date() }, refunded: true },
        { expiresAt: { lt: new Date() }, complete: false },
        { expiresAt: { lt: new Date() }, entries: { none: {} }, complete: true },
      ];

      AND.push({ OR });
    }
  }

  if (excludedUserIds?.length) {
    AND.push({ userId: { notIn: excludedUserIds } });
  }

  const orderBy: Prisma.BountyFindManyArgs['orderBy'] = [];
  if (sort === BountySort.EndingSoon) orderBy.push({ expiresAt: 'asc' });
  else if (sort === BountySort.HighestBounty)
    orderBy.push({ rank: { [`unitAmountCount${period}Rank`]: 'asc' } });
  else if (sort === BountySort.MostContributors)
    orderBy.push({ rank: { [`entryCount${period}Rank`]: 'asc' } });
  else if (sort === BountySort.MostDiscussed)
    orderBy.push({ rank: { [`commentCount${period}Rank`]: 'asc' } });
  else if (sort === BountySort.MostLiked)
    orderBy.push({ rank: { [`favoriteCount${period}Rank`]: 'asc' } });
  else if (sort === BountySort.MostTracked)
    orderBy.push({ rank: { [`trackCount${period}Rank`]: 'asc' } });
  else if (sort === BountySort.MostEntries)
    orderBy.push({ rank: { [`entryCount${period}Rank`]: 'asc' } });
  else orderBy.push({ createdAt: 'desc' });

  return dbRead.bounty.findMany({
    take,
    cursor: cursor ? { id: cursor } : undefined,
    select,
    where: {
      mode,
      name: query ? { contains: query } : undefined,
      type: types && !!types.length ? { in: types } : undefined,
      createdAt:
        period !== MetricTimeframe.AllTime
          ? { gte: decreaseDate(new Date(), 1, period.toLowerCase() as ManipulateType) }
          : undefined,
      AND,
    },
    orderBy,
  });
};

export const getBountyById = <TSelect extends Prisma.BountySelect>({
  id,
  select,
}: GetByIdInput & { select: TSelect }) => {
  return dbRead.bounty.findUnique({ where: { id }, select });
};

export const createBounty = async ({
  images,
  files,
  ownRights,
  tags,
  unitAmount,
  currency,
  startsAt: incomingStartsAt,
  expiresAt: incomingExpiresAt,
  buzzType,
  addLockedProperties,
  blurbUses,
  ...data
}: CreateBountyInput & {
  userId: number;
  /** Locks added by the server itself (the profanity filter), not by the caller. */
  addLockedProperties?: string[];
  /**
   * `undefined` means the feature was not evaluated for the owner and must NOT reconcile — an
   * empty array would delete every reference row. See `BlurbExpansion`.
   */
  blurbUses?: BlurbUse[];
}) => {
  const { userId } = data;
  switch (currency) {
    case Currency.BUZZ:
      const account = await getUserBuzzAccount({ accountId: userId });
      if ((account[0]?.balance ?? 0) < unitAmount) {
        throw throwInsufficientFundsError();
      }
      break;
    default: // Do no checks
      break;
  }

  if (buzzType === 'green' && data.nsfw) {
    throw new Error('When using Green Buzz, you are not allowed to create NSFW content');
  }

  // The columns are @db.Date: store the UTC day the caller picked.
  const startsAt = startOfDay(incomingStartsAt, { utc: true });
  const expiresAt = startOfDay(incomingExpiresAt, { utc: true });

  // Green buzz can never be spent on NSFW, so the flag is locked for the bounty's lifetime.
  const lockedProperties = uniq([
    ...(buzzType === 'green' ? ['nsfw'] : []),
    ...(addLockedProperties ?? []),
  ]);

  let imagesToIngest: IngestImageInput[] = [];
  const keysCheckedFor = await checkEntityImageKeys({ images, userId });

  const bounty = await dbWrite.$transaction(
    async (tx) => {
      const bounty = await tx.bounty.create({
        data: {
          ...data,
          lockedProperties: lockedProperties.length ? lockedProperties : undefined,
          startsAt,
          expiresAt,
          // TODO.bounty: Once we support tipping buzz fully, need to re-enable this
          entryMode: BountyEntryMode.BenefactorsOnly,
          details: (data.details as Prisma.JsonObject) ?? Prisma.JsonNull,
          tags: tags
            ? {
                create: tags.map((tag) => {
                  const name = tag.name.toLowerCase().trim();
                  return {
                    tag: {
                      connectOrCreate: {
                        where: { name },
                        create: { name, target: [TagTarget.Bounty] },
                      },
                    },
                  };
                }),
              }
            : undefined,
        },
      });

      if (files) {
        await updateEntityFiles({
          tx,
          entityId: bounty.id,
          entityType: 'Bounty',
          files,
          ownRights: !!ownRights,
        });
      }

      if (images) {
        imagesToIngest = await createEntityImages({
          images,
          tx,
          userId,
          keysCheckedFor,
          entityId: bounty.id,
          entityType: 'Bounty',
        });
      }

      switch (currency) {
        case Currency.BUZZ: {
          if (!buzzType) {
            throw throwBadRequestError('buzzType is required for Buzz bounties');
          }

          const prefix = getBountyTransactionPrefix(bounty.id, userId);
          // eslint-disable-next-line local-rules/no-io-in-transaction -- TODO(tx-io): Buzz charge inside the txn. Moving it out needs charge→tx→refund-on-failure compensation (a Postgres rollback can't undo an external Buzz charge); left for a domain-owner change.
          await createMultiAccountBuzzTransaction({
            fromAccountId: userId,
            fromAccountTypes: [buzzType],
            externalTransactionIdPrefix: prefix,
            toAccountId: 0,
            amount: unitAmount,
            type: TransactionType.Bounty,
            details: {
              entityId: bounty.id,
              entityType: 'Bounty',
            },
          });

          await tx.bountyBenefactor.create({
            data: {
              userId,
              bountyId: bounty.id,
              unitAmount,
              currency,
              buzzTransactionId: [prefix],
            },
          });

          break;
        }
        default: // Do no checks
          break;
      }

      if (blurbUses)
        await reconcileBlurbReferences({
          entityType: 'Bounty',
          entityId: bounty.id,
          uses: blurbUses,
          tx,
        });

      return bounty;
    },
    { maxWait: 10000, timeout: 30000 }
  );

  enqueueImageIngestion({
    images: imagesToIngest,
    name: 'bounty-image-ingest',
    userId,
  });

  if (bounty.userId) {
    await userBountyCountCache.refresh(bounty.userId);
  }

  return { ...bounty, details: bounty.details as BountyDetailsSchema | null };
};

export const updateBountyById = async ({
  id,
  files,
  ownRights,
  tags,
  details,
  startsAt: incomingStartsAt,
  expiresAt: incomingExpiresAt,
  images,
  userId,
  entryLimit,
  isModerator,
  addLockedProperties,
  blurbUses,
  ...data
}: UpdateBountyInput & {
  userId: number;
  isModerator?: boolean;
  /** Locks added by the server itself (the profanity filter), not by the caller. */
  addLockedProperties?: string[];
  /**
   * `undefined` means the feature was not evaluated for the owner and must NOT reconcile — an
   * empty array would delete every reference row. See `BlurbExpansion`.
   */
  blurbUses?: BlurbUse[];
}) => {
  // Convert dates to UTC for storing
  const startsAt = startOfDay(incomingStartsAt, { utc: true });
  const expiresAt = startOfDay(incomingExpiresAt, { utc: true });

  let imagesToIngest: IngestImageInput[] = [];
  const keysCheckedFor = await checkEntityImageKeys({ images, userId });

  const bounty = await dbWrite.$transaction(
    async (tx) => {
      const existing = await tx.bounty.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          entryLimit: true,
          complete: true,
          poi: true,
          meta: true,
          lockedProperties: true,
          _count: { select: { entries: true } },
        },
      });

      // Duplicated from upsertBounty on purpose: this is an exported service function, so
      // enforcement must not depend on every future caller remembering to do it first.
      enforceLockedProperties({
        data,
        storedLockedProperties: existing.lockedProperties,
        isModerator,
      });
      if (data.poi && !existing.poi && !isModerator)
        throw throwBadRequestError(
          'The creation of bounties intended to depict an actual person is prohibited.'
        );
      // A moderator clearing a text-scan poi flag un-hides the bounty and records the ruling, so
      // the expiry job pays out as normal and a rescan of the same text does not hide it again.
      const liftedTextScanPoi =
        isModerator &&
        existing.poi &&
        data.poi === false &&
        hasOpenTextScanFlag(existing.meta, 'poi');
      // Applied after enforcement, which drops every caller-supplied lock — these come from
      // the server, so they must survive it.
      if (addLockedProperties?.length)
        data.lockedProperties = uniq([
          ...(existing.lockedProperties ?? []),
          ...addLockedProperties,
        ]);

      if (existing.complete) throw throwBadRequestError('Cannot update a completed bounty');
      if (liftedTextScanPoi && isRemovedWithOwner(existing.meta))
        throw throwBadRequestError('This bounty is kept hidden until its payout settles');

      if (
        entryLimit &&
        existing.entryLimit &&
        entryLimit < existing.entryLimit &&
        existing._count.entries > 0
      ) {
        throw throwBadRequestError(
          'Cannot reduce entry limit because some users already submitted entries.'
        );
      }

      const bounty = await tx.bounty.update({
        where: { id },
        data: {
          ...data,
          ...(liftedTextScanPoi && {
            availability:
              (readTextScanFlags(existing.meta).poi?.prev?.availability as
                | Availability
                | undefined) ?? Availability.Public,
            meta: withTextScanDecision(existing.meta, 'poi', 'appealGranted', {
              at: new Date().toISOString(),
              by: userId,
              textHash: readTextScanFlags(existing.meta).poi?.textHash ?? null,
              via: 'moderator',
            }) as Prisma.JsonObject,
          }),
          entryLimit,
          startsAt,
          expiresAt,
          details: (details as Prisma.JsonObject) ?? Prisma.JsonNull,
          tags: tags
            ? {
                deleteMany: {
                  tagId: {
                    notIn: tags.filter(isTag).map((x) => x.id),
                  },
                },
                connectOrCreate: tags.filter(isTag).map((tag) => ({
                  where: { tagId_bountyId: { tagId: tag.id, bountyId: id } },
                  create: { tagId: tag.id },
                })),
                create: tags.filter(isNotTag).map((tag) => {
                  const name = tag.name.toLowerCase().trim();
                  return {
                    tag: {
                      connectOrCreate: {
                        where: { name },
                        create: { name, target: [TagTarget.Bounty] },
                      },
                    },
                  };
                }),
              }
            : undefined,
        },
      });

      if (!bounty) return null;

      if (files) {
        await updateEntityFiles({
          tx,
          entityId: bounty.id,
          entityType: 'Bounty',
          files,
          ownRights: !!ownRights,
        });
      }

      if (images) {
        imagesToIngest = await updateEntityImages({
          images,
          tx,
          entityId: bounty.id,
          entityType: 'Bounty',
          userId,
          keysCheckedFor,
        });
      }

      if (blurbUses)
        await reconcileBlurbReferences({
          entityType: 'Bounty',
          entityId: bounty.id,
          uses: blurbUses,
          tx,
        });

      return bounty;
    },
    { maxWait: 10000, timeout: 30000 }
  );

  enqueueImageIngestion({
    images: imagesToIngest,
    name: 'bounty-image-ingest',
    userId,
  });

  if (bounty?.userId) {
    await userBountyCountCache.refresh(bounty?.userId);
  }

  return bounty;
};

async function parseBountyInput<T extends z.ZodType>(schema: T, input: unknown) {
  const parsed = await schema.safeParseAsync(input);
  if (!parsed.success) throw throwBadRequestError(parsed.error.issues[0]?.message);
  return parsed.data as z.output<T>;
}

function assertBountyWindow({ startsAt, expiresAt }: { startsAt: Date; expiresAt: Date }) {
  if (expiresAt <= startsAt)
    throw throwBadRequestError('Expiration date must come after the start date');
}

export const upsertBounty = async ({
  id,
  userId,
  isModerator,
  buzzType,
  ...data
}: UpsertBountyInput & { userId: number; isModerator: boolean }) => {
  await throwOnBlockedUserContent(
    [data.name, data.description, ...(await newTagNames(data.tags?.map((tag) => tag.name)))],
    { isModerator, surface: 'bounty' }
  );

  const stored = id
    ? await dbRead.bounty.findUnique({
        where: { id },
        select: { lockedProperties: true, userId: true },
      })
    : null;
  const storedLockedProperties = stored?.lockedProperties ?? [];
  enforceLockedProperties({ data, storedLockedProperties, isModerator });

  // Re-expanded from the OWNER's rows rather than trusted from the client, and before the write
  // so what is stored is what the blurb actually says — and before the profanity filter below,
  // which must evaluate the text that will actually be published. A moderator saving someone
  // else's bounty resolves none of their blurbs, so they get the ids the bounty already
  // references instead of stripping every span.
  const ownerId = stored?.userId ?? userId;
  const restrictToBlurbIds =
    id && ownerId !== userId
      ? () => getReferencedBlurbIds({ entityType: 'Bounty', entityId: id })
      : undefined;
  const expansion = await expandBlurbs({
    userId: ownerId,
    html: data.description,
    restrictToBlurbIds,
  });
  data.description = expansion.html;

  // The guard above saw the CLIENT's html. Blurb bodies were spliced in since, so the string
  // about to be written is one it never checked.
  await throwOnBlockedUserContent(data.description, { isModerator, surface: 'bounty' });

  const addLockedProperties: string[] = [];
  if (!isModerator && (await legacyProfanityAutoNsfwApplies('Bounty', id))) {
    // Check bounty name and description for profanity using threshold-based evaluation
    const profanityFilter = createProfanityFilter();
    const textToCheck = [data.name, data.description].filter(Boolean).join(' ');
    const evaluation = profanityFilter.evaluateContent(textToCheck);

    // If profanity exceeds thresholds, mark bounty as NSFW
    if (evaluation.shouldMarkNSFW && !data.nsfw) {
      data.details = {
        ...data.details,
        profanityMatches: evaluation.matchedWords,
        profanityEvaluation: {
          reason: evaluation.reason,
          metrics: evaluation.metrics,
        },
      };
      // A stored nsfw lock is a moderator's call: keep the detection for review, but
      // never let the filter overturn it.
      if (!storedLockedProperties.includes('nsfw')) {
        data.nsfw = true;
        addLockedProperties.push('nsfw');
      }
    }
  }

  if (id) {
    const updateInput = await parseBountyInput(updateBountyInputSchema, { id, ...data });
    assertBountyWindow(updateInput);
    const updated = await updateBountyById({
      ...updateInput,
      userId,
      isModerator,
      addLockedProperties,
      blurbUses: expansion.evaluated ? expansion.uses : undefined,
    });
    if (updated) {
      await queueBountySearchIndexUpdate(updated.id);
      scanEntityInBackground({ entityType: 'Bounty', entityId: updated.id });
    }
    return updated;
  } else {
    if (data.poi) {
      throw throwBadRequestError(
        'The creation of bounties intended to depict an actual person is prohibited.'
      );
    }

    const createInput = await parseBountyInput(createBountyInputSchema, { ...data, buzzType });
    assertBountyWindow(createInput);
    const created = await createBounty({
      ...createInput,
      userId,
      addLockedProperties,
      blurbUses: expansion.evaluated ? expansion.uses : undefined,
    });
    await queueBountySearchIndexUpdate(created.id);
    scanEntityInBackground({ entityType: 'Bounty', entityId: created.id });
    return created;
  }
};

/**
 * The one path for "a bounty's description changed", for a caller holding only new HTML — the
 * blurb fan-out. `upsertBounty` is form-shaped, so a partial call to it would clear name, tags,
 * files, images and the entry limit rather than update a column.
 *
 * `updateBountyById`'s own follow-up — the image ingest queue and the owner's bounty COUNT —
 * is not repeated here: a re-materialised body moves neither.
 */
export async function applyBountyContentChange({
  id,
  description,
  expectedDescription,
}: {
  id: number;
  description: string;
  /**
   * Compare-and-set: the body this caller READ before splicing. The fan-out does load → splice →
   * save with nothing held across it, so a creator saving in that window had their edit silently
   * reverted by the replay — no error, and the save it clobbered had already returned success.
   * Supplied, a mismatch writes nothing and returns false; the reference stays pending and the
   * next pass re-reads. Omitted, the write is unconditional as before.
   */
  expectedDescription?: string;
}) {
  // The blocklist can move after a blurb was saved, and this path has no user in the loop to
  // catch it — same reason `applyArticleContentChange` re-checks.
  await throwOnBlockedUserContent(description, { surface: 'bounty' });

  const stored = await dbWrite.bounty.findUnique({
    where: { id },
    select: { name: true, nsfw: true, lockedProperties: true, details: true },
  });
  if (!stored) throw throwNotFoundError(`No bounty with id ${id}`);

  // Raw SQL because Prisma's @updatedAt fires on every client-side update(), and a blurb
  // re-materialization is not a creator edit.
  const affected =
    await dbWrite.$executeRaw`UPDATE "Bounty" SET description = ${description} WHERE id = ${id}${
      expectedDescription === undefined
        ? Prisma.empty
        : Prisma.sql` AND description = ${expectedDescription}`
    }`;
  // `stored` above already proved the row exists, so a zero here is the compare-and-set losing.
  if (!affected) {
    if (expectedDescription !== undefined) return false;
    throw throwNotFoundError(`No bounty with id ${id}`);
  }

  // `upsertBounty` runs this gate on the text a creator types. This path is the fan-out, which
  // has just written text that gate never saw — without it, editing a blurb puts profanity into a
  // published bounty while it keeps the SFW rating it earned with the old text. Evaluated
  // unconditionally: there is no acting moderator here to exempt, only the owner whose blurb
  // changed.
  const flagged = (await legacyProfanityAutoNsfwApplies('Bounty', id))
    ? evaluateAutoNsfw({
        name: stored.name,
        description,
        alreadyNsfw: stored.nsfw,
        lockedProperties: stored.lockedProperties,
      })
    : null;
  if (flagged) {
    const details = {
      ...((stored.details as MixedObject | null) ?? {}),
      ...flagged.metaPatch,
    } as Prisma.InputJsonObject;
    // Prisma rather than raw SQL, unlike the body write above: this fires rarely, and hand-rolling
    // the jsonb + text[] binds is where that trade stops being worth it.
    await dbWrite.bounty.update({
      where: { id },
      data: flagged.lock
        ? { nsfw: true, lockedProperties: uniq([...stored.lockedProperties, 'nsfw']), details }
        : { details },
    });
  }

  await queueBountySearchIndexUpdate(id);
  scanEntityInBackground({ entityType: 'Bounty', entityId: id });

  return true;
}

/**
 * The bounty save path enqueued nothing before this, so an edited bounty served its old
 * `description` in search results until a metric or entry event re-enqueued it. Called from
 * both `upsertBounty` and `applyBountyContentChange` so the two cannot diverge.
 *
 * The enqueue itself, not `bountiesSearchIndex.queueUpdate`, which is exactly this call with
 * `indexName` bound (base.search-index.ts) — reaching it through the index module would pull
 * `meilisearch/client` and its module-scope pLimit and prom collectors into this service's graph.
 */
function queueBountySearchIndexUpdate(id: number) {
  return SearchIndexUpdate.queueUpdate({
    indexName: BOUNTIES_SEARCH_INDEX,
    items: [{ id, action: SearchIndexUpdateQueueAction.Update }],
  });
}

/**
 * Ahead of deleting a bounty: an open one becomes a refund of its unawarded supporters. Returns
 * whether a payout is owed, for `settleBountyPayout`, or null for a missing bounty.
 */
export async function claimBountyRefundForDelete(id: number) {
  // An unpaid award is paid before the bounty becomes a refund: the refund leaves out awarded
  // supporters, and the delete then removes their rows.
  for (let attempt = 0; attempt < 3; attempt++) {
    const claim = await dbWrite.$transaction(async (tx) => {
      const locked = await lockBountyForPayout(tx, id);
      if (!locked) return null;
      if (locked.userId && !locked.complete && !locked.refunded) {
        if (isPayoutPending(locked)) return { awardPending: true } as const;
        await tx.bounty.update({
          where: { id },
          data: { complete: true, refunded: true, payoutRecordedAt: nextPayoutRecordedAt(locked) },
        });
        return { owed: true, firstAttempt: true };
      }
      return { owed: isPayoutPending(locked), firstAttempt: false };
    });
    if (!claim || !('awardPending' in claim)) return claim;
    // Still unpaid: owed, and the caller's settle reports it as failed.
    if (!(await settleBountyPayout(id))) return { owed: true, firstAttempt: false };
  }
  throw new Error(`Bounty ${id}: awards kept arriving; not claimed as a refund`);
}

export const deleteBountyById = async ({
  id,
  isModerator,
  userId,
}: GetByIdInput & { isModerator: boolean; userId: number }) => {
  const bounty = await getBountyById({
    id,
    select: { userId: true, expiresAt: true },
  });
  if (!bounty) throw throwNotFoundError('Bounty not found');

  if (!isModerator) {
    // If only entries created AFTER the cuttoff date are found, we'll allow deletion
    const entryCutOffDate = dayjs.utc(bounty.expiresAt).subtract(6, 'hour').toDate();
    const benefactorsCount = await dbWrite.bountyBenefactor.count({
      where: { bountyId: id, userId: bounty.userId ? { not: bounty.userId } : undefined },
    });
    const entriesCount = await dbWrite.bountyEntry.count({
      where: { bountyId: id, createdAt: { lte: entryCutOffDate } },
    });

    if (benefactorsCount !== 0 || entriesCount !== 0)
      throw throwBadRequestError('Cannot delete bounty because it has supporters and/or entries');
  }

  // The refund is claimed and paid before the row goes: deleting cascades the benefactor rows a
  // retry would refund from.
  const claim = await claimBountyRefundForDelete(id);
  if (!claim) return null;

  if (claim.owed) {
    const settled = await settleBountyPayout(id, {
      firstAttempt: claim.firstAttempt,
      refundDescription: isModerator
        ? 'Refund reason: moderator deleted bounty'
        : 'Refund reason: owner deleted bounty',
    });
    if (!settled && !(isModerator && (await refundUnpayableBountyAward(id)))) {
      const release = isModerator ? await releaseStuckBountyAward(id, userId) : null;
      if (release)
        throw new TRPCError({
          code: 'CONFLICT',
          message: `The bounty was NOT deleted. Its award could not be paid in full, so it was closed instead: the other awards were paid, supporters who had not awarded ${
            release.refundSettled
              ? 'were refunded'
              : 'are not all refunded yet (failed refunds are retried or logged for follow-up)'
          }, and ${release.unpaidAwards} award(s) were recorded for manual resolution.`,
        });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message:
          'The bounty could not be paid out, so it was not deleted. The payout is retried automatically; try deleting it again later.',
      });
    }
  }

  const markerView = await holdMarkerViewExists();
  const awardTable = await bountyUnpaidAwardTableExists(dbWrite);
  const result = await dbWrite.$transaction(async (tx) => {
    if (!(await lockBountyForPayout(tx, id))) return null;
    const stored = await tx.bounty.findUnique({ where: { id } });
    if (!stored) return null;
    // A held entrant, or an award recorded for manual resolution, keeps the bounty: hidden and
    // detached from its owner, deleted later by `bounty-payout-retry`.
    const keepsBounty = Prisma.sql`(${heldEntryOnBountySql(Prisma.raw('b.id'), markerView)}
      OR ${openUnpaidBountyAwardSql(Prisma.raw('b.id'), awardTable)})`;
    const doomed = Prisma.sql`SELECT b.id FROM "Bounty" b WHERE b.id = ${id} AND NOT ${keepsBounty}`;
    const [{ gone }] = await tx.$queryRaw<{ gone: boolean }[]>`
      WITH ${detachHeldThreadsCte(bountyThreadParents(doomed), markerView)},
      gone AS (DELETE FROM "Bounty" WHERE id IN (${doomed}) RETURNING id),
      files AS (
        DELETE FROM "File" WHERE "entityType" = 'Bounty' AND "entityId" IN (SELECT id FROM gone)
      ),
      hidden AS (
        UPDATE "Bounty" b
        SET availability = 'Private'::"Availability",
            "userId" = NULL,
            meta = ${asJsonbObjectSql('b.meta')} || jsonb_build_object(
              'removedWithOwner', true,
              'availabilityBeforeRemoval', b.availability,
              'userIdBeforeRemoval', b."userId"
            )
        WHERE b.id = ${id} AND ${keepsBounty} AND ${notRemovedWithOwnerSql('b.meta')}
      )
      SELECT EXISTS (SELECT 1 FROM gone) AS gone`;
    return { bounty: stored, gone };
  });
  if (!result) return null;
  if (!result.gone)
    await SearchIndexUpdate.queueUpdate({
      indexName: BOUNTIES_SEARCH_INDEX,
      items: [{ id, action: SearchIndexUpdateQueueAction.Delete }],
    });
  return result.bounty;
};

export const getBountyImages = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId?: number; isModerator?: boolean }) => {
  const imageOr: Prisma.Enumerable<Prisma.ImageWhereInput> = isModerator
    ? [{ ingestion: { notIn: [] } }]
    : [{ ingestion: ImageIngestionStatus.Scanned, needsReview: null }];

  if (userId) imageOr.push({ userId });

  const connections = await dbRead.imageConnection.findMany({
    where: {
      entityId: id,
      entityType: 'Bounty',
      image: { OR: imageOr },
    },
    select: { image: { select: imageSelect } },
  });

  return connections.map(({ image }) => ({
    ...image,
    nsfwLevel: image.nsfwLevel as NsfwLevel,
    tags: image.tags.map((t) => t.tag),
  }));
};

export const getBountyFiles = async ({ id }: GetByIdInput) => {
  const files = await dbRead.file.findMany({
    where: { entityId: id, entityType: 'Bounty' },
    select: {
      id: true,
      url: true,
      metadata: true,
      sizeKB: true,
      name: true,
    },
  });

  return files;
};

async function lockBenefactorForSupport(
  tx: Prisma.TransactionClient,
  bountyId: number,
  userId: number
) {
  const locked = await lockBountyForPayout(tx, bountyId);
  if (!locked) throw throwNotFoundError('Bounty not found');
  if (locked.complete || locked.refunded || isPayoutOverdue(locked))
    throw throwBadRequestError('Bounty is already complete');

  const benefactor = await tx.bountyBenefactor.findUnique({
    where: { bountyId_userId: { userId, bountyId } },
    select: {
      unitAmount: true,
      currency: true,
      buzzTransactionId: true,
      awardedToId: true,
      awardedAt: true,
    },
  });
  if (!benefactor) throw throwNotFoundError('You are not a benefactor of this bounty');
  // `awardedAt` outlives the awarded entry: an award stands after its entry is deleted.
  if (benefactor.awardedToId || benefactor.awardedAt)
    throw throwBadRequestError('You have already awarded an entry on this bounty');
  return benefactor;
}

export const addBenefactorUnitAmount = async ({
  bountyId,
  unitAmount,
  userId,
  buzzType,
}: AddBenefactorUnitAmountInputSchema & { userId: number; buzzType: BuzzSpendType }) => {
  const bounty = await dbRead.bounty.findUnique({
    where: { id: bountyId },
    select: { id: true, startsAt: true },
  });
  if (!bounty) throw throwNotFoundError('Bounty not found');
  assertBountyStarted(bounty);

  const { currency } = await dbWrite.$transaction((tx) =>
    lockBenefactorForSupport(tx, bountyId, userId)
  );
  const addSupport = (prefix?: string) =>
    dbWrite.$transaction(async (tx) => {
      const benefactor = await lockBenefactorForSupport(tx, bountyId, userId);
      return tx.bountyBenefactor.update({
        where: { bountyId_userId: { userId, bountyId } },
        data: {
          unitAmount: benefactor.unitAmount + unitAmount,
          ...(prefix
            ? { buzzTransactionId: [...(benefactor.buzzTransactionId ?? []), prefix] }
            : {}),
        },
      });
    });

  if (currency !== Currency.BUZZ) return addSupport();

  if (buzzType === 'blue') throw throwBadRequestError('You cannot use Blue Buzz for bounties.');
  const account = await getUserBuzzAccount({ accountId: userId });
  if ((account[0]?.balance ?? 0) < unitAmount) throw throwInsufficientFundsError();

  const prefix = getBountyTransactionPrefix(bountyId, userId);
  await createMultiAccountBuzzTransaction({
    fromAccountId: userId,
    fromAccountTypes: [buzzType],
    externalTransactionIdPrefix: prefix,
    toAccountId: 0,
    amount: unitAmount,
    type: TransactionType.Bounty,
    description: 'You have supported a bounty',
    details: { entityId: bountyId, entityType: 'Bounty' },
  });

  try {
    return await addSupport(prefix);
  } catch (error) {
    // The charge is already taken; any failure to record support must refund it.
    await refundBountyPrefix(prefix, 'Refund reason: bounty support was not added', {
      bountyId,
      userId,
      unitAmount,
    }).catch((refundError) =>
      logBountyPayoutError({
        bountyId,
        userId,
        message: `Support charge ${prefix} was not added and its refund failed: ${String(
          refundError
        )}`,
      })
    );
    throw error;
  }
};

export const getImagesForBounties = async ({
  bountyIds,
  userId,
  isModerator,
}: {
  bountyIds: number[];
  userId?: number;
  isModerator?: boolean;
}) => {
  const imageOr: Prisma.Enumerable<Prisma.ImageWhereInput> = isModerator
    ? [{ ingestion: { notIn: [] } }]
    : [{ ingestion: ImageIngestionStatus.Scanned, needsReview: null }];
  if (userId) imageOr.push({ userId });

  const connections = await dbRead.imageConnection.findMany({
    where: {
      entityType: 'Bounty',
      entityId: { in: bountyIds },
      image: { OR: imageOr },
    },
    select: {
      entityId: true,
      image: { select: imageSelect },
    },
  });

  const groupedImages = groupBy(
    connections.map(({ entityId, image }) => ({
      ...image,
      nsfwLefel: image.nsfwLevel as NsfwLevel,
      tags: image.tags.map((t) => ({ id: t.tag.id, name: t.tag.name })),
      entityId,
      metadata: image.metadata as ImageMetadata | VideoMetadata | null,
    })),
    'entityId'
  );

  return groupedImages;
};

function logBountyPayoutError({
  bountyId,
  userId,
  message,
  name = 'bounty-refund',
}: {
  bountyId: number;
  userId?: number | null;
  message: string;
  name?: 'bounty-refund' | 'bounty-award';
}) {
  logToAxiom({
    name,
    type: 'error',
    message: `Bounty ${bountyId}: ${message}`,
    bountyId,
    userId,
  }).catch(() => null);
}

async function refundBountyPrefix(txId: string, description: string, details: MixedObject) {
  if (isBountyTransactionPrefix(txId)) {
    await refundAllLegsByPrefix({ externalTransactionIdPrefix: txId, description, details });
    return;
  }
  try {
    await refundTransaction(txId, description);
  } catch (error) {
    // A single transaction: 409 means an earlier attempt already refunded it.
    const status = getBuzzApiStatus(error);
    if (status === 404 || status === 409) return;
    throw error;
  }
}

/**
 * Returns every benefactor's Buzz (only the unawarded ones with `onlyUnawarded`). Call it only
 * after a committed claim under `lockBountyForPayout`. A failed refund is logged per benefactor
 * and the rest continue.
 *
 * Refunds by transaction id are safe to repeat. Legacy rows without ids are paid by a plain
 * transaction that is not, so a retry (`includeLegacy: false`) skips them.
 */
export async function refundBountyBenefactorFunds({
  bountyId,
  currency,
  onlyUnawarded = false,
  includeLegacy = true,
  description = 'Reason: Bounty refund',
}: {
  bountyId: number;
  currency: Currency;
  onlyUnawarded?: boolean;
  includeLegacy?: boolean;
  description?: string;
}): Promise<{ refunded: number[]; failed: number[] }> {
  const outcome = { refunded: [] as number[], failed: [] as number[] };
  if (currency !== Currency.BUZZ) return outcome;
  const benefactors = await dbWrite.bountyBenefactor.findMany({
    // An award keeps `awardedAt` after its entry is deleted and `awardedToId` is nulled.
    where: { bountyId, currency, ...(onlyUnawarded ? { awardedToId: null, awardedAt: null } : {}) },
    select: { userId: true, unitAmount: true, buzzTransactionId: true },
  });

  for (const { userId, unitAmount, buzzTransactionId } of benefactors) {
    if (unitAmount <= 0) continue;
    try {
      if (buzzTransactionId && buzzTransactionId.length > 0) {
        const txResults = await Promise.allSettled(
          buzzTransactionId.map((txId) =>
            refundBountyPrefix(txId, description, { bountyId, userId, unitAmount })
          )
        );
        const failed = txResults.flatMap((result, index) =>
          result.status === 'rejected'
            ? [`${buzzTransactionId[index]} - ${String(result.reason)}`]
            : []
        );
        if (failed.length) {
          logBountyPayoutError({
            bountyId,
            userId,
            message: `Failed to refund transactions ${failed.join(', ')}`,
          });
          outcome.failed.push(userId);
          continue;
        }
      } else if (includeLegacy) {
        await createBuzzTransaction({
          fromAccountId: 0,
          toAccountId: userId,
          amount: unitAmount,
          type: TransactionType.Refund,
          description,
        });
      } else {
        logBountyPayoutError({ bountyId, userId, message: 'Legacy refund not retried' });
        continue;
      }
      outcome.refunded.push(userId);
    } catch (e) {
      logBountyPayoutError({ bountyId, userId, message: `Refund failed - ${String(e)}` });
      outcome.failed.push(userId);
    }
  }
  return outcome;
}

// Not `bounty-award-<id>-…`: awards before this key used that shape with an entry id OR a bounty
// id, so a bounty id could match an old entry award and read as already paid.
const bountyAwardTransactionId = (bountyId: number, supporterId: number, accountType: string) =>
  `bounty-award-b${bountyId}-u${supporterId}-${accountType}`;

type AwardedFunds = { userId: number; unitAmount: number; buzzTransactionId: string[] | null };

type SupporterCharge = { userId: number; chargedAt: number; amount: number };

/** A supporter whose charges the ledger has no record of: no retry can price their award. */
class UnpriceableAwardError extends Error {}

/** Unix seconds, from the time the charge prefix carries; 0 for a charge that has none. */
const prefixChargedAt = (prefix: string) =>
  Math.floor((Number(prefix.split('-').at(-1)) || 0) / 1000);

/**
 * What each supporter was charged, by colour and charge time: each colour is paid as its own row.
 * Throws when a lookup fails: an award paid on partial amounts would spend its keys on them.
 */
async function bountyAwardAmounts(benefactors: AwardedFunds[]) {
  const amounts: Partial<Record<BuzzAccountType, SupporterCharge[]>> = {};
  const add = (accountType: BuzzAccountType, userId: number, chargedAt: number, amount: number) => {
    if (amount <= 0) return;
    const charges = (amounts[accountType] ??= []);
    const same = charges.find((c) => c.userId === userId && c.chargedAt === chargedAt);
    if (same) same.amount += amount;
    else charges.push({ userId, chargedAt, amount });
  };
  for (const { userId, unitAmount, buzzTransactionId } of benefactors) {
    const ids = buzzTransactionId ?? [];
    const prefixes = ids.filter(isBountyTransactionPrefix);
    const charged = await Promise.all(
      prefixes.map(async (prefix) => ({
        chargedAt: prefixChargedAt(prefix),
        charges: await getMultiAccountTransactionsByPrefix(prefix),
      }))
    );
    if (
      prefixes.length &&
      prefixes.length === ids.length &&
      !charged.some((c) => c.charges.length) &&
      unitAmount > 0
    )
      throw new UnpriceableAwardError('No charge transactions found for the award');
    let total = 0;
    for (const { chargedAt, charges } of charged)
      for (const charge of charges) {
        add(charge.accountType as BuzzAccountType, userId, chargedAt, charge.amount);
        total += charge.amount;
      }
    // Charges made before multi-account Buzz have no per-type record; they were yellow.
    if (prefixes.length < ids.length || !ids.length) add('yellow', userId, 0, unitAmount - total);
  }
  return amounts;
}

/**
 * Refunds a supporter whose award can no longer be paid, in the colours it was charged in. Returns
 * false if any refund fails. Safe to repeat: charges refund by transaction id, and a legacy charge
 * pays under a fixed key.
 */
async function refundAwardingSupporter(bountyId: number, supporter: AwardedFunds) {
  const { userId, unitAmount, buzzTransactionId } = supporter;
  const description = 'Reason: Bounty refund, the awarded entry was deleted';
  try {
    if (buzzTransactionId?.length) {
      for (const txId of buzzTransactionId)
        await refundBountyPrefix(txId, description, { bountyId, userId, unitAmount });
    } else if (unitAmount > 0) {
      const result = await createBuzzTransactionMany([
        {
          fromAccountId: 0,
          toAccountId: userId,
          amount: unitAmount,
          type: TransactionType.Refund,
          description,
          details: { bountyId },
          externalTransactionId: `bounty-award-refund-b${bountyId}-u${userId}`,
        },
      ]);
      if (!result.transactions.length && !result.conflicts.length) return false;
    }
  } catch (e) {
    logBountyPayoutError({ bountyId, userId, message: `Award refund failed - ${String(e)}` });
    return false;
  }
  const activity = 'refundDeletedBountyAward';
  const logged = await dbWrite.modActivity.findFirst({
    where: { entityType: 'bounty', entityId: bountyId, activity, userId },
    select: { id: true },
  });
  if (!logged)
    await dbWrite.modActivity.create({
      data: { userId, entityType: 'bounty', entityId: bountyId, activity },
    });
  return true;
}

/** `ok` is false on any failure other than an unpriceable supporter, which is listed in `unpriceable` instead. */
type AwardOutcome = { ok: boolean; unpriceable: number[] };

/**
 * The supporters are the rows with `awardedAt`. Each is paid to the owner of the entry it awarded.
 * `awardedToId` is nulled when that entry is deleted: the latest award is then paid to the winner
 * captured on the bounty, and an earlier one is refunded to its supporter.
 *
 * An award dated at or before `settledAt` was paid by that settlement (see `nextPayoutRecordedAt`),
 * under this key or an older one, and is skipped: its entry may since have been deleted.
 *
 * Each supporter is paid on its own: one that fails does not stop the others.
 */
async function payBountyAward(
  bountyId: number,
  winnerUserId: number | null,
  settledAt: Date | null
): Promise<AwardOutcome> {
  const outcome: AwardOutcome = { ok: true, unpriceable: [] };
  if (!winnerUserId) {
    logBountyPayoutError({ bountyId, name: 'bounty-award', message: 'Award has no winner to pay' });
    return { ...outcome, ok: false };
  }
  const awardedRows = await dbWrite.bountyBenefactor.findMany({
    where: { bountyId, awardedAt: { not: null } },
    select: {
      userId: true,
      unitAmount: true,
      currency: true,
      buzzTransactionId: true,
      awardedAt: true,
      awartedTo: { select: { userId: true } },
    },
  });
  const awarded = awardedRows.filter((b) => !settledAt || !b.awardedAt || b.awardedAt > settledAt);
  if (!awarded.length) {
    logBountyPayoutError({
      bountyId,
      userId: winnerUserId,
      name: 'bounty-award',
      message: 'Award recorded but no supporter is marked as awarding it',
    });
    return { ...outcome, ok: false };
  }
  // The expiry job awards every remaining supporter at once, under one `awardedAt`.
  const latestAt = Math.max(...awarded.map((b) => b.awardedAt?.getTime() ?? 0));

  for (const supporter of awarded) {
    if (supporter.currency !== Currency.BUZZ) continue;
    const isLatest = supporter.awardedAt?.getTime() === latestAt;
    const payee = supporter.awartedTo?.userId ?? (isLatest ? winnerUserId : null);
    try {
      const paid = payee
        ? await payAwardingSupporter(bountyId, supporter, payee)
        : await refundAwardingSupporter(bountyId, supporter);
      if (!paid) outcome.ok = false;
    } catch (e) {
      if (e instanceof UnpriceableAwardError) outcome.unpriceable.push(supporter.userId);
      else outcome.ok = false;
      logBountyPayoutError({
        bountyId,
        userId: supporter.userId,
        name: 'bounty-award',
        message: `Award payout failed - ${String(e)}`,
      });
    }
  }
  return outcome;
}

async function payAwardingSupporter(bountyId: number, supporter: AwardedFunds, payee: number) {
  const transactions = Object.entries(await bountyAwardAmounts([supporter])).map(
    ([accountType, charges = []]) => ({
      fromAccountId: 0,
      toAccountId: payee,
      toAccountType: accountType as BuzzAccountType,
      amount: charges.reduce((sum, c) => sum + c.amount, 0),
      type: TransactionType.Bounty,
      description: 'Reason: Bounty entry has been awarded!',
      // Who funded the award, on the ledger row itself: it outlives the bounty, and bankable
      // netting reads it (`BOUNTY_AWARD_SQL`).
      details: {
        entityId: bountyId,
        entityType: 'Bounty',
        // Flat number arrays, one entry per charge, the shape tips already store (`targetUserIds`).
        supporterIds: charges.map((c) => c.userId),
        supporterAmounts: charges.map((c) => c.amount),
        supporterChargedAt: charges.map((c) => c.chargedAt),
      },
      externalTransactionId: bountyAwardTransactionId(bountyId, supporter.userId, accountType),
    })
  );
  if (!transactions.length) return true;

  const result = await createBuzzTransactionMany(transactions);
  // A conflict is the ledger already holding the key: an earlier attempt paid it.
  if (result.transactions.length + result.conflicts.length < transactions.length) {
    logBountyPayoutError({
      bountyId,
      userId: payee,
      name: 'bounty-award',
      message: 'The ledger neither made nor recognised every award transaction',
    });
    return false;
  }
  return true;
}

/**
 * Moves the Buzz for a recorded award or refund and stamps `payoutSettledAt`. Safe to repeat: awards
 * pay under fixed keys and refunds treat an already-refunded charge as done. Returns whether the
 * bounty owes nothing more. `firstAttempt` is false for retries, which skip legacy refunds.
 */
export async function settleBountyPayout(
  bountyId: number,
  {
    firstAttempt = false,
    refundDescription,
  }: { firstAttempt?: boolean; refundDescription?: string } = {}
) {
  const bounty = await dbWrite.bounty.findUnique({
    where: { id: bountyId },
    select: {
      refunded: true,
      payoutRecordedAt: true,
      payoutSettledAt: true,
      payoutWinnerUserId: true,
    },
  });
  if (!bounty || !isPayoutPending(bounty)) return true;

  let settled = false;
  try {
    settled = bounty.refunded
      ? (
          await refundBountyBenefactorFunds({
            bountyId,
            currency: Currency.BUZZ,
            onlyUnawarded: true,
            includeLegacy: firstAttempt,
            description: refundDescription,
          })
        ).failed.length === 0
      : await payBountyAward(bountyId, bounty.payoutWinnerUserId, bounty.payoutSettledAt).then(
          ({ ok, unpriceable }) => ok && !unpriceable.length
        );
  } catch (e) {
    logBountyPayoutError({ bountyId, message: `Payout failed - ${String(e)}` });
  }
  if (!settled) return false;

  // Only the payout read above: one recorded since then is still owed. Never before it was
  // recorded, which a clock behind the recording one would stamp.
  const { payoutRecordedAt } = bounty;
  await dbWrite.bounty.updateMany({
    where: { id: bountyId, payoutRecordedAt },
    data: { payoutSettledAt: new Date(Math.max(Date.now(), payoutRecordedAt?.getTime() ?? 0)) },
  });
  return true;
}

/**
 * Invariant: once an award is recorded, its `awardedAt` marks and `payoutWinnerUserId` are cleared
 * only here. Clearing them anywhere else would let an award that was paid but not yet stamped
 * settled be refunded as well.
 *
 * The moderator override for a recorded award no retry can pay: it has no winner, or no supporter is
 * marked as awarding it. The award becomes a refund to its supporters, and the caller may delete once
 * this returns true. If the refund also fails, the supporter rows are logged before the delete
 * cascades them away. Any other unsettled payout, such as a Buzz failure, returns false and blocks.
 */
export async function refundUnpayableBountyAward(bountyId: number) {
  const converted = await dbWrite.$transaction(async (tx) => {
    const locked = await lockBountyForPayout(tx, bountyId);
    if (!locked || locked.refunded || !isPayoutPending(locked)) return false;
    const settledAt = locked.payoutSettledAt;
    const unpayable =
      !locked.payoutWinnerUserId ||
      !(await tx.bountyBenefactor.count({
        where: { bountyId, awardedAt: settledAt ? { gt: settledAt } : { not: null } },
      }));
    if (!unpayable) return false;
    // An award an earlier settlement paid keeps its marks, so the refund below leaves it out.
    await tx.bountyBenefactor.updateMany({
      where: settledAt
        ? { bountyId, OR: [{ awardedAt: null }, { awardedAt: { gt: settledAt } }] }
        : { bountyId },
      data: { awardedToId: null, awardedAt: null },
    });
    await tx.bounty.update({
      where: { id: bountyId },
      data: { refunded: true, payoutWinnerUserId: null },
    });
    return true;
  });
  if (!converted) return false;

  logBountyPayoutError({
    bountyId,
    name: 'bounty-award',
    message: 'Award could not be paid; refunding its supporters instead',
  });
  const refunded = await settleBountyPayout(bountyId, {
    firstAttempt: true,
    refundDescription: 'Reason: Bounty refund, the award could not be paid',
  });
  if (!refunded) {
    const benefactors = await dbWrite.bountyBenefactor.findMany({
      where: { bountyId },
      select: { userId: true, unitAmount: true, currency: true, buzzTransactionId: true },
    });
    logToAxiom({
      name: 'bounty-refund',
      type: 'error',
      message: `Bounty ${bountyId}: refund of an unpayable award failed; deleted by a moderator anyway`,
      bountyId,
      benefactors,
    }).catch(() => null);
  }
  return true;
}

const BOUNTY_PAYOUT_RETRY_BATCH_SIZE = 100;
const BOUNTY_PAYOUT_RETRY_MAX_BATCHES = 20;

const STUCK_AWARD_RELEASE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Moderator exit for an award that a supporter with no charge on record keeps from settling.
 * Closes the bounty as a refund of the supporters who never awarded, keeps it, and records each
 * unpriced award (neither paid nor refunded) for a manual ruling. Needs every unpriced award to be a
 * day old. Returns the recorded count and whether the refund settled, or null when it does not apply.
 */
export async function releaseStuckBountyAward(
  bountyId: number,
  moderatorId: number,
  now = Date.now()
) {
  // The record is what the ruling reads; without its table there is no release.
  if (!(await bountyUnpaidAwardTableExists(dbWrite))) return null;
  const read = await dbWrite.bounty.findUnique({
    where: { id: bountyId },
    select: {
      refunded: true,
      payoutRecordedAt: true,
      payoutSettledAt: true,
      payoutWinnerUserId: true,
    },
  });
  if (!read || read.refunded || !isPayoutPending(read)) return null;

  // Twice: an empty lookup must repeat before it counts as no charge on record.
  const pay = () => payBountyAward(bountyId, read.payoutWinnerUserId, read.payoutSettledAt);
  const first = await pay();
  if (!first.ok || !first.unpriceable.length) return null;
  const second = await pay();
  const unpriceable = first.unpriceable.filter((id) => second.unpriceable.includes(id));
  if (!second.ok || !unpriceable.length) return null;

  const unpaid = await dbWrite.bountyBenefactor.findMany({
    where: { bountyId, userId: { in: unpriceable } },
    select: { userId: true, unitAmount: true, buzzTransactionId: true, awardedAt: true },
  });
  if (
    unpaid.length !== unpriceable.length ||
    unpaid.some((b) => !b.awardedAt || b.awardedAt.getTime() > now - STUCK_AWARD_RELEASE_AFTER_MS)
  )
    return null;

  // Overdue, so no award's own settle is still running. The awarding marks stay, so the refund
  // skips every award.
  const claimed = await dbWrite.$transaction(async (tx) => {
    const locked = await lockBountyForPayout(tx, bountyId);
    if (
      !locked ||
      locked.refunded ||
      !isPayoutOverdue(locked, now) ||
      locked.payoutRecordedAt?.getTime() !== read.payoutRecordedAt?.getTime()
    )
      return false;
    await tx.bounty.update({
      where: { id: bountyId },
      data: { complete: true, refunded: true, payoutRecordedAt: nextPayoutRecordedAt(locked) },
    });
    const meta = locked.meta as { userIdBeforeRemoval?: number } | null;
    await tx.bountyUnpaidAward.createMany({
      data: unpaid.map((b) => ({
        bountyId,
        userId: b.userId,
        unitAmount: b.unitAmount,
        buzzTransactionIds: b.buzzTransactionId,
        winnerUserId: read.payoutWinnerUserId,
        ownerId: locked.userId ?? meta?.userIdBeforeRemoval ?? null,
        recordedById: moderatorId,
      })),
    });
    await tx.modActivity.createMany({
      data: unpaid.map(({ userId }) => ({
        userId,
        entityType: 'bounty',
        entityId: bountyId,
        activity: BOUNTY_AWARD_UNPAID_ACTIVITY,
      })),
    });
    return true;
  });
  if (!claimed) return null;

  // Straight after the claim: only this first settle pays legacy refunds.
  const refundSettled = await settleBountyPayout(bountyId, {
    firstAttempt: true,
    refundDescription: 'Reason: Bounty refund, the bounty was closed by a moderator',
  });
  for (const supporter of unpaid)
    await logToAxiom({
      name: 'bounty-award',
      type: 'error',
      message: `Bounty ${bountyId}: award from user ${supporter.userId} has no charge on record; neither paid nor refunded, for a manual ruling`,
      bountyId,
      userId: supporter.userId,
      unitAmount: supporter.unitAmount,
      buzzTransactionId: supporter.buzzTransactionId,
      winnerUserId: read.payoutWinnerUserId,
      moderatorId,
    }).catch(() => null);
  return { unpaidAwards: unpaid.length, refundSettled };
}

/**
 * Records the ruling on an award `releaseStuckBountyAward` recorded as unpaid. Moves no Buzz: the
 * ruling is settled in the ledger first, and this only lets the bounty be deleted again.
 */
export async function resolveUnpaidBountyAward({
  bountyId,
  userId,
  ruling,
  ledgerReference,
  moderatorId,
}: {
  bountyId: number;
  userId: number;
  ruling: BountyAwardRuling;
  ledgerReference: string;
  moderatorId: number;
}) {
  if (!(await bountyUnpaidAwardTableExists(dbWrite)))
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Unpaid bounty awards cannot be resolved yet: their table does not exist',
    });
  const notFound = () =>
    new TRPCError({
      code: 'NOT_FOUND',
      message: `No award from user ${userId} on bounty ${bountyId} is recorded for manual resolution`,
    });
  const recorded = await dbWrite.$transaction(async (tx) => {
    const locked = await lockBountyForPayout(tx, bountyId);
    if (!locked) throw notFound();
    const key = { bountyId_userId: { bountyId, userId } };
    let award = await tx.bountyUnpaidAward.findUnique({ where: key });
    // Recorded in ModActivity before the table existed.
    if (!award) {
      const legacy = await tx.modActivity.findFirst({
        where: {
          entityType: 'bounty',
          entityId: bountyId,
          userId,
          activity: BOUNTY_AWARD_UNPAID_ACTIVITY,
        },
        select: { createdAt: true },
      });
      const supporter =
        legacy &&
        (await tx.bountyBenefactor.findUnique({
          where: key,
          select: { unitAmount: true, buzzTransactionId: true },
        }));
      if (!supporter) throw notFound();
      const meta = locked.meta as { userIdBeforeRemoval?: number } | null;
      award = await tx.bountyUnpaidAward.create({
        data: {
          bountyId,
          userId,
          unitAmount: supporter.unitAmount,
          buzzTransactionIds: supporter.buzzTransactionId,
          winnerUserId: locked.payoutWinnerUserId,
          ownerId: locked.userId ?? meta?.userIdBeforeRemoval ?? null,
          recordedAt: legacy.createdAt,
        },
      });
    }
    if (award.resolvedAt) {
      if (award.ruling === ruling) return false;
      throw new TRPCError({
        code: 'CONFLICT',
        message: `That award is already resolved as ${award.ruling}`,
      });
    }
    await tx.bountyUnpaidAward.update({
      where: key,
      data: { ruling, ledgerReference, resolvedById: moderatorId, resolvedAt: new Date() },
    });
    await tx.modActivity.create({
      data: {
        userId: moderatorId,
        entityType: 'bounty',
        entityId: bountyId,
        activity: BOUNTY_AWARD_RESOLVED_ACTIVITY,
      },
    });
    return true;
  });
  if (recorded)
    await logToAxiom({
      name: 'bounty-award',
      type: 'info',
      message: `Bounty ${bountyId}: unpaid award from user ${userId} resolved as ${ruling}`,
      bountyId,
      userId,
      ruling,
      ledgerReference,
      moderatorId,
    }).catch(() => null);
  return { recorded };
}

export async function retryUnsettledBountyPayouts({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - BOUNTY_PAYOUT_RETRY_AFTER_MS);
  let cursor = 0;
  let settled = 0;
  for (let batch = 0; batch < BOUNTY_PAYOUT_RETRY_MAX_BATCHES; batch++) {
    const due = await dbWrite.$queryRaw<{ id: number }[]>`
      SELECT b.id FROM "Bounty" b
      WHERE b.id > ${cursor} AND ${payoutPendingSql} AND b."payoutRecordedAt" <= ${cutoff}
      ORDER BY b.id
      LIMIT ${BOUNTY_PAYOUT_RETRY_BATCH_SIZE}`;
    if (!due.length) break;
    cursor = due[due.length - 1].id;
    for (const { id } of due) if (await settleBountyPayout(id)) settled++;
    if (due.length < BOUNTY_PAYOUT_RETRY_BATCH_SIZE) break;
  }
  return { settled };
}

/** A kept bounty is detached from its owner, who is recorded in meta.userIdBeforeRemoval. */
const keptBountyOwnerSql = Prisma.raw(
  `COALESCE(b."userId", (b.meta ->> 'userIdBeforeRemoval')::int)`
);

/**
 * Kept bounties that never had a payout or supporters, or whose payout is settled: any other still
 * owes supporters. One whose owner or an entrant is held waits for the first run after the hold ends,
 * and one with an award recorded for manual resolution waits until it is resolved.
 */

export async function deleteSettledKeptBounties() {
  const markerView = await holdMarkerViewExists();
  const awardTable = await bountyUnpaidAwardTableExists(dbWrite);
  const doomed = Prisma.sql`SELECT b.id FROM "Bounty" b
    WHERE b.meta ->> 'removedWithOwner' = 'true'
      AND ((b."payoutRecordedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM "BountyBenefactor" bb WHERE bb."bountyId" = b.id))
        OR (b.complete AND b."payoutSettledAt" >= b."payoutRecordedAt"))
      AND NOT ${ownerHeldSql(keptBountyOwnerSql)}
      AND NOT ${heldEntryOnBountySql(Prisma.raw('b.id'), markerView)}
      AND NOT ${openUnpaidBountyAwardSql(Prisma.raw('b.id'), awardTable)}`;
  const deleted = await dbWrite.$queryRaw<{ id: number }[]>`
    WITH ${detachHeldThreadsCte(bountyThreadParents(doomed), markerView)},
    gone AS (DELETE FROM "Bounty" WHERE id IN (${doomed}) RETURNING id),
    files AS (
      DELETE FROM "File" WHERE "entityType" = 'Bounty' AND "entityId" IN (SELECT id FROM gone)
    )
    SELECT id FROM gone`;
  if (!deleted.length) return 0;
  await SearchIndexUpdate.queueUpdate({
    indexName: BOUNTIES_SEARCH_INDEX,
    items: deleted.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Delete })),
  });
  return deleted.length;
}

export const refundBounty = async ({
  id,
  isModerator,
}: GetByIdInput & { isModerator: boolean }) => {
  if (!isModerator) {
    throw throwAuthorizationError();
  }

  const bountyFindArgs = {
    where: { id },
    select: {
      name: true,
      id: true,
      user: { select: { id: true, email: true } },
    },
  } as const;
  const bounty = await dbRead.bounty.findUniqueOrThrow(bountyFindArgs).catch(() => {
    dbReadFallbackCounter.inc({ entity: 'bounty', caller: 'refundBounty' });
    return dbWrite.bounty.findUniqueOrThrow(bountyFindArgs);
  });

  const updated = await dbWrite.$transaction(async (tx) => {
    const locked = await lockBountyForPayout(tx, id);
    if (!locked) throw throwNotFoundError('Bounty not found');
    if (locked.complete || locked.refunded)
      throw throwBadRequestError('This bounty has already been awarded or refunded');
    if (isPayoutPending(locked))
      throw throwBadRequestError('An award on this bounty is still being paid. Try again later.');

    const benefactors = await tx.bountyBenefactor.findMany({
      where: { bountyId: id },
      select: { userId: true, currency: true, awardedToId: true, awardedAt: true },
    });
    // `awardedAt` outlives the awarded entry.
    if (benefactors.some((b) => b.awardedToId != null || b.awardedAt != null))
      throw throwBadRequestError(
        'At least one benefactor has awarded an entry. This bounty is not refundable.'
      );

    if (!benefactors.some((b) => b.userId === locked.userId))
      throw throwBadRequestError('No currency found for bounty');

    return tx.bounty.update({
      where: { id },
      data: { complete: true, refunded: true, payoutRecordedAt: nextPayoutRecordedAt(locked) },
    });
  });

  await settleBountyPayout(id, { firstAttempt: true });

  if (bounty.user) {
    bountyRefundedEmail.send({
      bounty,
      user: bounty.user,
    });
  }

  if (updated.userId) {
    await userBountyCountCache.refresh(updated.userId);
  }

  return updated;
};
