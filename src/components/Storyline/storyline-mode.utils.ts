import { PG_INT4_MAX } from '~/server/common/constants';
import type { StorylinePathChapter } from '~/server/services/storyline.service';
import { STORYLINE_PATH_LIMIT } from '~/shared/utils/storyline';

/**
 * Storyline mode lives in the URL, as the end chapter of the path being read. Image detail
 * carries the query string through every navigation, so the mode survives paging and a shared
 * link opens in the storyline; dropping the param is what leaving does.
 */
export const STORYLINE_CHAPTER_PARAM = 'storylineChapter';
/**
 * The way the reader came into each chapter on their path where branches rejoin, as a comma list
 * of the chapters before them. Absent on a path with no rejoin, so those links are unchanged.
 */
export const STORYLINE_VIA_PARAM = 'storylineVia';

export function parseIdParam(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(id) && id > 0 ? id : undefined;
}

export function parseIdListParam(value: unknown) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' && typeof raw !== 'number') return [];
  // Within what getPath accepts, so a hand-edited link cannot fail the whole read.
  return String(raw)
    .split(',')
    .flatMap((part) => {
      const id = parseIdParam(part);
      return id && id <= PG_INT4_MAX ? [id] : [];
    })
    .slice(0, STORYLINE_PATH_LIMIT);
}

/**
 * The `via` that reproduces a route. The server takes the oldest link wherever `via` says nothing,
 * so only chapters with several parents are named.
 */
export function routeVia(route: { chapterId: number; parentCount?: number }[]) {
  return route.flatMap((chapter, i) =>
    i > 0 && (chapter.parentCount ?? 0) > 1 ? [route[i - 1].chapterId] : []
  );
}

export function storylineReadHref({
  imageId,
  chapterId,
  via = [],
}: {
  imageId: number;
  chapterId: number;
  via?: number[];
}) {
  const query = new URLSearchParams({ [STORYLINE_CHAPTER_PARAM]: String(chapterId) });
  if (via.length) query.set(STORYLINE_VIA_PARAM, via.join(','));
  return `/images/${imageId}?${query.toString().replace(/%2C/g, ',')}`;
}

export type StorylineReadTarget = { imageId: number; chapterId: number; via: number[] };

/**
 * Where a chapter link goes: storyline mode at its first image on the route `via` names, or its
 * post when this reader sees none of its images. Null for a chapter this reader may not see.
 */
export function storylineChapterLink(
  chapter: { chapterId: number; post: { id: number } | null; firstImage: { id: number } | null },
  via: number[]
): { href: string; read: StorylineReadTarget | null } | null {
  if (!chapter.post) return null;
  if (!chapter.firstImage) return { href: `/posts/${chapter.post.id}`, read: null };
  const read = { imageId: chapter.firstImage.id, chapterId: chapter.chapterId, via };
  return { href: storylineReadHref(read), read };
}

/** Path order first, then each post's own image order: the image query itself orders by recency. */
export function orderPathImages<
  T extends { id: number; postId: number | null; index: number | null }
>(images: T[], postIds: number[]) {
  const position = new Map(postIds.map((id, i) => [id, i]));
  return images
    .filter((image) => image.postId != null && position.has(image.postId))
    .sort(
      (a, b) =>
        (position.get(a.postId as number) ?? 0) - (position.get(b.postId as number) ?? 0) ||
        (a.index ?? 0) - (b.index ?? 0) ||
        a.id - b.id
    );
}

export function getStorylineWalk(
  chapters: StorylinePathChapter[],
  images: { id: number; postId: number | null }[]
) {
  const chapterIdByPostId = new Map<number, number>();
  for (const chapter of chapters)
    if (chapter.post) chapterIdByPostId.set(chapter.post.id, chapter.chapterId);

  const chapterIdByImageId = new Map<number, number>();
  const firstImageIdByChapterId = new Map<number, number>();
  for (const image of images) {
    const chapterId = image.postId != null ? chapterIdByPostId.get(image.postId) : undefined;
    if (chapterId == null) continue;
    chapterIdByImageId.set(image.id, chapterId);
    if (!firstImageIdByChapterId.has(chapterId)) firstImageIdByChapterId.set(chapterId, image.id);
  }
  return { chapterIdByImageId, firstImageIdByChapterId };
}

const tombstoneLabels: Record<NonNullable<StorylinePathChapter['tombstone']>, string> = {
  deleted: 'This chapter was deleted',
  removed: 'This chapter was removed',
  unavailable: 'This chapter is not available',
  aboveStoryRating: "This chapter is rated above the storyline's maximum",
  browsingLevel: 'This chapter is hidden by your browsing level',
};

export function getStorylineTombstoneLabel(reason: NonNullable<StorylinePathChapter['tombstone']>) {
  return tombstoneLabels[reason];
}

/**
 * A chapter by someone the reader hid reads as unavailable, like one by someone they blocked:
 * the server only knows about blocks, and the image read already drops hidden users' images.
 */
export function hideHiddenUsersChapters<
  T extends { tombstone: StorylinePathChapter['tombstone']; post: { userId: number } | null }
>(chapters: T[], hiddenUserIds: ReadonlySet<number>): T[] {
  if (!hiddenUserIds.size) return chapters;
  return chapters.map((chapter) =>
    chapter.post && hiddenUserIds.has(chapter.post.userId)
      ? ({ ...chapter, tombstone: 'unavailable', post: null } as T)
      : chapter
  );
}

export type PendingContinue =
  | { kind: 'wait' }
  | { kind: 'open'; imageId: number }
  | { kind: 'end' };

/**
 * After a reader takes a branch: wait until the branch's path and images have arrived, then open
 * its first image, or, when it has none this reader can see, show its end-of-chapter view so
 * what follows a hidden chapter stays reachable.
 */
export function resolvePendingContinue({
  pendingChapterId,
  pathEndId,
  imagesFetching,
  firstImageIdByChapterId,
}: {
  pendingChapterId: number;
  pathEndId: number | undefined;
  imagesFetching: boolean;
  firstImageIdByChapterId: ReadonlyMap<number, number>;
}): PendingContinue {
  if (pathEndId !== pendingChapterId || imagesFetching) return { kind: 'wait' };
  const imageId = firstImageIdByChapterId.get(pendingChapterId);
  return imageId ? { kind: 'open', imageId } : { kind: 'end' };
}

/** A storyline is walked, not looped: past its last image is the end-of-chapter view. */
export function getStorylineStep(index: number, length: number, direction: 'next' | 'previous') {
  if (direction === 'next') return index >= length - 1 ? 'end' : 'move';
  return index > 0 ? 'move' : 'stay';
}

/**
 * Carousel navigation that stops at a storyline's ends; outside one (`onEnd` absent) it loops.
 * `onCloseEnd` is passed while the end-of-chapter view is open: previous closes it in place.
 */
export function withStorylineNavigation<
  T extends { index: number; next: () => void; previous: () => void }
>(
  navigation: T,
  length: number,
  onEnd: (() => void) | undefined,
  onCloseEnd?: (() => void) | undefined
): T {
  if (!onEnd) return navigation;
  return {
    ...navigation,
    next: () => {
      if (getStorylineStep(navigation.index, length, 'next') === 'end') onEnd();
      else navigation.next();
    },
    previous: () => {
      if (onCloseEnd) onCloseEnd();
      else if (getStorylineStep(navigation.index, length, 'previous') === 'move')
        navigation.previous();
    },
  };
}

export function uniquePostIds(images: { postId?: number | null }[] | undefined) {
  return [...new Set((images ?? []).flatMap((image) => (image.postId ? [image.postId] : [])))];
}

/**
 * Path images page until the path is whole, so an image deep in a long path counts as on it.
 * A failed page stops the paging instead of re-requesting it in a loop, and stops counting as
 * loading, so a reader waiting on a branch is not held forever.
 */
export function getPathImagesPaging({
  hasNextPage,
  isFetching,
  isError,
  pages,
  maxPages,
}: {
  hasNextPage: boolean;
  isFetching: boolean;
  isError: boolean;
  pages: number;
  maxPages: number;
}) {
  const wantsMore = hasNextPage && !isError && pages < maxPages;
  return { fetchNext: wantsMore && !isFetching, loading: isFetching || wantsMore };
}

/**
 * A chapter's name: its post's title, else its number (and author, where nothing else shows it); a
 * tombstone reads as its reason.
 */
export function getStorylineChapterName(
  chapter: Pick<StorylinePathChapter, 'depth' | 'post' | 'tombstone'>,
  { withAuthor = false }: { withAuthor?: boolean } = {}
) {
  if (!chapter.post) return getStorylineTombstoneLabel(chapter.tombstone ?? 'deleted');
  const number = `Chapter ${chapter.depth + 1}`;
  const author = withAuthor && chapter.post.username ? ` by ${chapter.post.username}` : '';
  return chapter.post.title || `${number}${author}`;
}

type SubwayChapter = Pick<StorylinePathChapter, 'chapterId' | 'depth' | 'post' | 'tombstone'> & {
  parentCount?: number;
  /** Branches that join the line here: the stop's parents other than the stop before it. */
  joins?: Pick<StorylinePathChapter, 'chapterId' | 'depth' | 'post' | 'tombstone'>[];
};
export type SubwayStop<T extends SubwayChapter> = {
  chapter: SubwayChapter;
  /** On the path being read (walked), or on the canon line ahead of its end. */
  kind: 'path' | 'ahead';
  /** Continuations leaving this stop other than the next stop on the line. */
  branches: T[];
  joins: NonNullable<SubwayChapter['joins']>;
};

/**
 * The drawer's line: the path being read, then the canon chapters after its end, with every
 * other continuation hung off the stop it leaves from and every branch that joins it marked.
 * Numbers run along the line, so a chapter where branches rejoin is numbered by the way the
 * reader came, and so are the ways off it.
 */
export function buildSubwayStops<T extends SubwayChapter>(
  path: SubwayChapter[],
  ahead: SubwayChapter[],
  childrenByChapterId: ReadonlyMap<number, T[]>
): SubwayStop<T>[] {
  const line = [
    ...path.map((chapter) => ({ chapter, kind: 'path' as const })),
    ...ahead.map((chapter) => ({ chapter, kind: 'ahead' as const })),
  ];
  const firstDepth = line[0]?.chapter.depth ?? 0;
  return line.map((stop, i) => {
    const next = line[i + 1]?.chapter.chapterId;
    const branches = (childrenByChapterId.get(stop.chapter.chapterId) ?? [])
      .filter((child) => child.chapterId !== next)
      .map((child) => ({ ...child, depth: firstDepth + i + 1 }));
    return {
      ...stop,
      chapter: { ...stop.chapter, depth: firstDepth + i },
      branches,
      joins: stop.chapter.joins ?? [],
    };
  });
}

/**
 * The stops on the canon line ahead that have a way off it, nearest first, at most `limit`.
 * Every stop but the last has its canon child among its children, so it forks only past one; the
 * last has no canon child, so any child is a way off.
 */
export function canonAheadForkStops(
  ahead: { chapterId: number; childCount: number }[],
  limit: number
) {
  return ahead
    .filter((stop, i) => stop.childCount > (i === ahead.length - 1 ? 0 : 1))
    .slice(0, limit)
    .map((stop) => stop.chapterId);
}

/**
 * The line is the reader's path then the canon ahead of its end, so it is "the canon path" only
 * while every chapter of the path is on the main route (`onMain` absent counts as on). `length` is
 * undefined until the canon ahead is known.
 */
export function storylinePositionLabel({
  number,
  length,
  path,
}: {
  number: number;
  length: number | undefined;
  path: { onMain?: boolean }[];
}) {
  const line = path.some((chapter) => chapter.onMain === false) ? 'this path' : 'the canon path';
  return `Chapter ${number}${length ? ` of ${length} on ${line}` : ''}`;
}

export type StorylineShares = { total: number; shares: Record<number, number> } | undefined;

/** Readers who took a way, from its share of the total; a way nobody took reads 0. */
export function getForkShare(shares: StorylineShares, chapterId: number) {
  if (!shares || shares.total <= 0) return null;
  // Choices recorded but no split returned: a server still withholding shares under a minimum.
  // Showing 0% everywhere would be false, so show nothing.
  if (!Object.keys(shares.shares).length) return null;
  const share = shares.shares[chapterId] ?? 0;
  return { percent: Math.round(share * 100), readers: Math.round(share * shares.total) };
}
