import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwOnBlockedLinkDomain } from '~/server/services/blocklist.service';
import { hashContent } from '~/server/services/entity-moderation.service';
import {
  throwBadRequestError,
  throwConflictError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

export const MAX_BLURBS_PER_USER = 20;

// The index is PARTIAL (`WHERE "deletedAt" IS NULL`, so a deleted blurb stops squatting its name),
// which Prisma cannot express and therefore does not know about — it reports the raw index name
// rather than mapping it back to `['userId', 'name']`. Both shapes are accepted so this keeps
// working either way.
const BLURB_NAME_INDEX = 'Blurb_userId_name_key';

function isUniqueNameViolation(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
    return false;
  const target = error.meta?.target;
  if (typeof target === 'string') return target === BLURB_NAME_INDEX;
  return Array.isArray(target) && (target as string[]).includes('name');
}

// Names are immutable by design: a blurb's name is how a creator refers to it,
// and there is no update path that writes it. See "Names cannot be changed" in
// docs/features/reusable-text-blurbs.md.
export async function createBlurb({
  userId,
  name,
  content,
}: {
  userId: number;
  name: string;
  content: string;
}) {
  // A blurb body is spliced into entities whose own domain check already ran, so it has to be
  // caught on this write too.
  await throwOnBlockedLinkDomain(content);

  const existing = await dbWrite.blurb.count({ where: { userId, deletedAt: null } });
  if (existing >= MAX_BLURBS_PER_USER)
    throw throwBadRequestError(`You have reached the limit of ${MAX_BLURBS_PER_USER} blurbs.`);

  try {
    return await dbWrite.blurb.create({
      data: { userId, name, content, contentHash: hashContent(content), updatedAt: new Date() },
    });
  } catch (error) {
    if (isUniqueNameViolation(error))
      throw throwConflictError(`You already have a blurb named "${name}".`);
    throw error;
  }
}

export async function updateBlurbContent({
  userId,
  id,
  content,
}: {
  userId: number;
  id: number;
  content: string;
}) {
  await throwOnBlockedLinkDomain(content);

  const blurb = await dbWrite.blurb.findFirst({ where: { id, userId, deletedAt: null } });
  if (!blurb) throw throwNotFoundError('Blurb not found.');

  return dbWrite.blurb.update({
    where: { id },
    data: { content, contentHash: hashContent(content) },
  });
}

export async function softDeleteBlurb({ userId, id }: { userId: number; id: number }) {
  const blurb = await dbWrite.blurb.findFirst({ where: { id, userId, deletedAt: null } });
  if (!blurb) throw throwNotFoundError('Blurb not found.');

  // Soft, because BlurbReference cascades: a hard delete destroys the rows naming
  // the entities whose spans still need unwrapping. The fan-out job does that work
  // and hard-deletes the blurb once no references remain.
  await dbWrite.blurb.update({ where: { id }, data: { deletedAt: new Date() } });
}

export async function getBlurbsForUser(userId: number) {
  const blurbs = await dbRead.blurb.findMany({
    where: { userId, deletedAt: null },
    orderBy: { name: 'asc' },
  });
  const counts = await dbRead.blurbReference.groupBy({
    by: ['blurbId', 'entityType'],
    where: { blurbId: { in: blurbs.map((b) => b.id) } },
    _count: { _all: true },
  });

  const referencesByBlurbId = new Map<number, Record<string, number>>();
  for (const { blurbId, entityType, _count } of counts) {
    const byEntityType = referencesByBlurbId.get(blurbId) ?? {};
    byEntityType[entityType] = _count._all;
    referencesByBlurbId.set(blurbId, byEntityType);
  }

  return blurbs.map((b) => {
    const referencesByEntityType = referencesByBlurbId.get(b.id) ?? {};
    const referenceCount = Object.values(referencesByEntityType).reduce((sum, n) => sum + n, 0);
    return { ...b, referenceCount, referencesByEntityType };
  });
}
