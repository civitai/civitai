import { Prisma } from '@prisma/client';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import type {
  CreateChangelogInput,
  DeleteChangelogInput,
  GetChangelogsInput,
  UpdateChangelogInput,
} from '~/server/schema/changelog.schema';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import {
  expandBlurbs,
  reconcileBlurbReferences,
} from '~/server/services/blurb-materialize.service';
import { throwDbError, throwNotFoundError } from '~/server/utils/errorHandling';
import { createKeyedTtlMemo } from '~/server/utils/ttl-memoize';
import { DomainColor } from '~/shared/utils/prisma/enums';

export type Changelog = AsyncReturnType<typeof getChangelogs>['items'][number];
export const getChangelogs = async (input: GetChangelogsInput & { hasFeature: boolean }) => {
  const { hasFeature, limit, cursor, sortDir, search, dateBefore, dateAfter, types, tags, domain } =
    input;

  const where: Prisma.ChangelogWhereInput = {
    sticky: false,
    domain: { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] },
  };

  if (!hasFeature) {
    where['disabled'] = false;
  }

  if (search && search.length > 0) {
    where['OR'] = [
      { title: { contains: search, mode: 'insensitive' } },
      { content: { contains: search, mode: 'insensitive' } },
    ];
  }

  const now = new Date();
  const dateAfterMod = !dateAfter
    ? undefined
    : dateAfter.getTime() > now.getTime()
    ? now
    : dateAfter;
  const dateBeforeMod = !dateBefore
    ? hasFeature
      ? undefined
      : now
    : dateBefore.getTime() > now.getTime()
    ? now
    : dateBefore;

  if (dateAfterMod) {
    where['effectiveAt'] = { lte: dateBeforeMod, gte: dateAfterMod };
  } else {
    where['effectiveAt'] = { lte: dateBeforeMod };
  }

  if (types && types.length > 0) {
    where['type'] = { in: types };
  }

  // TODO this is an "or", do we want to change it to "and"? or offer option?
  if (tags && tags.length > 0) {
    where['tags'] = { hasSome: tags };
  }

  const skip = cursor ?? 0;

  const select = Prisma.validator<Prisma.ChangelogSelect>()({
    id: true,
    title: true,
    titleColor: true,
    content: true,
    link: true,
    cta: true,
    effectiveAt: true,
    updatedAt: true,
    createdAt: true,
    type: true,
    tags: true,
    disabled: true,
    sticky: true,
    domain: true,
  });

  try {
    const data = await dbRead.changelog.findMany({
      select,
      where,
      take: limit + 1,
      skip,
      orderBy: [{ effectiveAt: sortDir }, { id: sortDir }],
    });

    const hasMore = data.length > limit;
    if (hasMore) {
      data.pop();
    }

    const whereSticky: Prisma.ChangelogWhereInput = { ...where, sticky: true };

    if (!hasFeature) {
      whereSticky['disabled'] = false;
    }

    const now = new Date();
    const dateBeforeMod = hasFeature ? undefined : now;
    whereSticky['effectiveAt'] = { lte: dateBeforeMod };

    const stickyItems =
      skip > 0
        ? []
        : await dbRead.changelog.findMany({
            select,
            where: whereSticky,
            orderBy: [{ effectiveAt: 'desc' }, { id: 'desc' }],
          });

    const retData = [...stickyItems, ...data];

    return {
      items: retData,
      nextCursor: hasMore ? skip + data.length : undefined,
    };
  } catch (error) {
    throw throwDbError(error);
  }
};

// `Changelog` has no author column, so blurb spans resolve against the MODERATOR making the
// edit. Consequence, and it is the reason there is no `restrictToBlurbIds` call here: another
// moderator editing an entry unwraps a span they do not own to the text it already carries.
// Nothing is lost, only the live reference; there is no owner to key on instead.
export const createChangelog = async (data: CreateChangelogInput & { userId: number }) => {
  const { userId, ...input } = data;
  try {
    const { html: content, uses } = await expandBlurbs({ userId, html: input.content });
    const created = await dbWrite.changelog.create({
      data: { ...input, content, updatedAt: input.effectiveAt },
    });
    await reconcileBlurbReferences({
      entityType: 'Changelog',
      entityId: created.id,
      uses,
    });
    return created;
  } catch (error) {
    throw throwDbError(error);
  }
};

export const updateChangelog = async (data: UpdateChangelogInput & { userId: number }) => {
  const { id, userId, ...rest } = data;

  try {
    if (rest.content === undefined) {
      return await dbWrite.changelog.update({ where: { id }, data: rest });
    }

    const { html: content, uses } = await expandBlurbs({ userId, html: rest.content });
    const updated = await dbWrite.changelog.update({
      where: { id },
      data: { ...rest, content },
    });
    await reconcileBlurbReferences({ entityType: 'Changelog', entityId: id, uses });
    return updated;
  } catch (error) {
    throw throwDbError(error);
  }
};

/**
 * The one path for "a changelog's body changed", for a caller holding only new HTML — the blurb
 * fan-out. `updateChangelog` takes a whole form payload, so a partial call to it would clear
 * title, tags, link and domain rather than update a column.
 *
 * The write is the whole of it: changelogs are not indexed, not text-moderated, and not cached
 * per row (`getLatestChangelog`'s memo keys on `effectiveAt`, which this never moves). So unlike
 * the other surfaces there is no shared follow-up for the interactive path to route through.
 */
export async function applyChangelogContentChange({
  id,
  content,
}: {
  id: number;
  content: string;
}) {
  // The blocklist can move after a blurb was saved, and this path has no user in the loop to
  // catch it — same reason `applyArticleContentChange` re-checks.
  await throwOnBlockedLinkDomain(content);

  // Raw SQL because Prisma's @updatedAt fires on every client-side update(), and a blurb
  // re-materialization is not a moderator edit: the changelog list stamps "Updated" on any entry
  // whose `updatedAt` runs more than an hour past `createdAt`.
  const affected =
    await dbWrite.$executeRaw`UPDATE "Changelog" SET content = ${content} WHERE id = ${id}`;
  if (!affected) throw throwNotFoundError(`No changelog with id ${id}`);
}

export const deleteChangelog = async ({ id }: DeleteChangelogInput) => {
  try {
    return dbWrite.changelog.delete({
      where: { id },
    });
  } catch (error) {
    throw throwDbError(error);
  }
};

export const getAllTags = async (input?: { domain?: DomainColor }) => {
  const { domain } = input ?? {};

  const data = await dbRead.changelog.findMany({
    select: { tags: true },
    where: {
      disabled: false,
      effectiveAt: { lte: new Date() },
      domain: { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] },
    },
  });

  return [...new Set(data.flatMap((x) => x.tags ?? []))];
};

// Global-per-domain "latest changelog" timestamp — identical for every user of a
// given domain color. Previously an uncached dbRead.findFirst on EVERY call; an
// in-proc (per-pod), per-domain TTL memo collapses that to ~1 DB read / domain /
// TTL / pod.
//
// Staleness: this in-proc TTL (CacheTTL.xs, 60s) STACKS on top of the existing
// edgeCacheIt({ ttl: CacheTTL.xs }) 60s CDN cache (+ staleWhileRevalidate 30s) on
// the resolver, so worst-case value age is ~2×TTL (~120s). And `new Date()` in
// the where-clause below is frozen for the memo window, so a scheduled /
// future-dated changelog can surface up to ~TTL (~60s) late. Immaterial for
// minute-scale banner data. Fail-open: a DB error propagates uncached (see
// createKeyedTtlMemo).
const LATEST_CHANGELOG_INPROC_TTL_MS = CacheTTL.xs * 1000;

const getLatestChangelogMemo = createKeyedTtlMemo<number>(async (domainKey) => {
  const domain = domainKey ? (domainKey as DomainColor) : undefined;

  const cl = await dbRead.changelog.findFirst({
    select: { effectiveAt: true },
    where: {
      disabled: false,
      effectiveAt: { lte: new Date() },
      domain: { hasSome: domain ? [DomainColor.all, domain] : [DomainColor.all] },
    },
    orderBy: { effectiveAt: 'desc' },
    // take: 1,
  });

  return !cl ? 0 : cl.effectiveAt.getTime();
}, LATEST_CHANGELOG_INPROC_TTL_MS);

export const getLatestChangelog = async (input?: { domain?: DomainColor }) => {
  return getLatestChangelogMemo(input?.domain ?? '');
};
