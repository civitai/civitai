import {
  getStorylineChapterName,
  routeVia,
  storylineChapterLink,
} from '~/components/Storyline/storyline-mode.utils';
import type { StorylinePathChapter } from '~/server/services/storyline.service';
import type { StorylineLaneEdge, StorylineLanes } from '~/shared/utils/storyline-lanes';
import { createStorylineLaneRouter, layoutStorylineLanes } from '~/shared/utils/storyline-lanes';

type LaneMapChapter = StorylinePathChapter & { firstImage: { id: number } | null };

/**
 * Whether a storyline may have branches to map: some chapter is off its canon path. Any fork
 * leaves one there, while the canon path alone can stop short of a fork (at the first chapter
 * with no canon child, or at its length cap).
 */
export const storylineMayBranch = (storyline: { chapterCount: number; mainPath: unknown[] }) =>
  storyline.chapterCount > storyline.mainPath.length;

/**
 * The Story page map of a storyline graph: its lane layout, and for each chapter the name and link
 * the map shows. Both follow the route the map draws to the chapter, so the number in an untitled
 * chapter's name is the one the reader shows when the link opens it. Null without chapter 1.
 */
export function buildStorylineLaneMap<T extends LaneMapChapter>(graph: {
  rootChapterId: number | null;
  chapters: T[];
  edges: StorylineLaneEdge[];
  truncated: boolean;
}) {
  if (!graph.rootChapterId) return null;
  const layout = layoutStorylineLanes(
    graph.rootChapterId,
    graph.chapters.map((c) => c.chapterId),
    graph.edges
  );
  const routeTo = createStorylineLaneRouter(layout);
  const chapterById = new Map(graph.chapters.map((c) => [c.chapterId, c]));
  const parentCount = new Map<number, number>();
  for (const link of layout.links)
    parentCount.set(link.chapterId, (parentCount.get(link.chapterId) ?? 0) + 1);

  const nodes = layout.nodes.flatMap((node) => {
    const chapter = chapterById.get(node.chapterId);
    if (!chapter) return [];
    const route = routeTo(node.chapterId).map((chapterId) => ({
      chapterId,
      parentCount: parentCount.get(chapterId),
    }));
    const link = storylineChapterLink(chapter, routeVia(route));
    const onRoute = { ...chapter, depth: route.length - 1 };
    return {
      ...node,
      chapter,
      /** Its number on the route its link opens. */
      number: route.length,
      title: getStorylineChapterName(onRoute),
      name: getStorylineChapterName(onRoute, { withAuthor: true }),
      href: link?.href ?? null,
      read: link?.read ?? null,
    };
  });
  return { layout, nodes, truncated: graph.truncated };
}

/**
 * The canon path as lane-0 nodes in the map's shape, for a story with nothing to branch (or
 * before its graph arrives). `parentCount` names the way in past a rejoin, as on the map.
 */
export function buildCanonLane<
  T extends Pick<StorylinePathChapter, 'chapterId' | 'depth' | 'post' | 'tombstone'> & {
    firstImage: { id: number } | null;
    parentCount?: number;
  }
>(path: T[]) {
  return path.map((chapter, i) => {
    const link = storylineChapterLink(chapter, routeVia(path.slice(0, i + 1)));
    return {
      chapterId: chapter.chapterId,
      row: i,
      lane: 0,
      chapter,
      number: chapter.depth + 1,
      title: getStorylineChapterName(chapter),
      name: getStorylineChapterName(chapter, { withAuthor: true }),
      href: link?.href ?? null,
      read: link?.read ?? null,
    };
  });
}

export type StorylineLaneBand =
  /** Before the first row of the ways on from `chapterId`, in lane order. */
  | { kind: 'fork'; chapterId: number; number: number; childIds: number[]; lane: number }
  /** Before a chapter where `joining` other paths arrive; `authors` wrote the chapters they leave. */
  | { kind: 'rejoin'; chapterId: number; joining: number; authors: string[]; lane: number };

type LaneRowNode = {
  chapterId: number;
  row: number;
  lane: number;
  number: number;
  chapter: { post: { username: string | null } | null };
};

/**
 * The lane map as a list: per row its canon chapter (lane 0) and its branch chapters, and before
 * it the bands that say where the story forks and where paths join back.
 */
export function buildStorylineLaneRows<N extends LaneRowNode>(
  layout: Pick<StorylineLanes, 'rows' | 'links'>,
  nodes: N[]
) {
  const rows = Array.from({ length: layout.rows }, (_, row) => ({
    row,
    canon: null as N | null,
    branches: [] as N[],
    bands: [] as StorylineLaneBand[],
  }));
  const byId = new Map(nodes.map((n) => [n.chapterId, n]));
  for (const node of nodes) {
    if (node.lane === 0) rows[node.row].canon = node;
    else rows[node.row].branches.push(node);
  }
  for (const row of rows) row.branches.sort((a, b) => a.lane - b.lane);

  const out = new Map<number, typeof layout.links>();
  const into = new Map<number, typeof layout.links>();
  for (const link of layout.links) {
    out.set(link.parentChapterId, [...(out.get(link.parentChapterId) ?? []), link]);
    into.set(link.chapterId, [...(into.get(link.chapterId) ?? []), link]);
  }

  const forks: { row: number; band: StorylineLaneBand }[] = [];
  for (const [chapterId, links] of out) {
    const parent = byId.get(chapterId);
    if (!parent || links.length < 2) continue;
    const ordered = [...links].sort((a, b) => a.to.lane - b.to.lane);
    forks.push({
      row: Math.min(...links.map((l) => l.to.row)),
      band: {
        kind: 'fork',
        chapterId,
        number: parent.number,
        childIds: ordered.map((l) => l.chapterId),
        lane: ordered.find((l) => l.to.lane !== parent.lane)?.lane ?? parent.lane,
      },
    });
  }
  const rejoins: { row: number; band: StorylineLaneBand }[] = [];
  for (const [chapterId, links] of into) {
    const node = byId.get(chapterId);
    if (!node || links.length < 2) continue;
    const joining = links.filter((l) => l.from.lane !== node.lane);
    const from = joining.length ? joining : links.slice(1);
    const authors = [
      ...new Set(from.flatMap((l) => byId.get(l.parentChapterId)?.chapter.post?.username ?? [])),
    ];
    rejoins.push({
      row: node.row,
      band: { kind: 'rejoin', chapterId, joining: from.length, authors, lane: from[0].lane },
    });
  }
  // At one boundary, where a branch leaves is read before where another arrives.
  for (const { row, band } of [...forks, ...rejoins]) rows[row]?.bands.push(band);
  return rows;
}
