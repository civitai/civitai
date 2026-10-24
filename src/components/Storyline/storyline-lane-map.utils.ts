import {
  getStorylineChapterName,
  routeVia,
  storylineChapterLink,
} from '~/components/Storyline/storyline-mode.utils';
import type { StorylinePathChapter } from '~/server/services/storyline.service';
import type { StorylineLaneEdge, StorylineLanes } from '~/shared/utils/storyline-lanes';
import { createStorylineLaneRouter, layoutStorylineLanes } from '~/shared/utils/storyline-lanes';

type LaneMapChapter = StorylinePathChapter & { firstImage: { id: number } | null };

export const LANE_COLORS = ['blue', 'grape', 'teal', 'orange', 'pink', 'lime', 'cyan', 'yellow'];
export const laneColor = (lane: number) =>
  `var(--mantine-color-${LANE_COLORS[lane % LANE_COLORS.length]}-6)`;

/**
 * The lane the map draws a chapter in. Lane 0 is the canon column, so a chapter the layout put
 * there that is not on the canon path gets the spare lane after the last.
 */
export const storylineDisplayLane = (
  layout: { lanes: number },
  node: { lane: number },
  onCanon: boolean
) => (node.lane === 0 && !onCanon ? layout.lanes : node.lane);

/**
 * The lane of each chapter of a reader's path that is off the main route, as the map draws it. A
 * chapter on the main route, or one the graph does not hold (it is capped, or still loading), is
 * left out and keeps the plain look.
 */
export function getStorylinePathLanes(
  graph:
    | {
        rootChapterId: number | null;
        chapters: { chapterId: number }[];
        edges: StorylineLaneEdge[];
      }
    | null
    | undefined,
  path: { chapterId: number; onMain: boolean }[]
) {
  const lanes = new Map<number, number>();
  if (!graph?.rootChapterId) return lanes;
  const layout = layoutStorylineLanes(
    graph.rootChapterId,
    graph.chapters.map((c) => c.chapterId),
    graph.edges
  );
  const laneOf = new Map(layout.nodes.map((n) => [n.chapterId, n]));
  for (const { chapterId, onMain } of path) {
    const placed = laneOf.get(chapterId);
    if (!onMain && placed) lanes.set(chapterId, storylineDisplayLane(layout, placed, false));
  }
  return lanes;
}

/**
 * Whether a storyline may have branches to map: some chapter is off its canon path. Any fork
 * leaves one there, while the canon path alone can stop short of a fork (at the first chapter
 * with no canon child, or at its length cap).
 */
export const storylineMayBranch = (storyline: { chapterCount: number; mainPath: unknown[] }) =>
  storyline.chapterCount > storyline.mainPath.length;

/**
 * The edges (`parentChapterId:chapterId`) an owner may put a chapter into: not the way into a
 * contributor's chapter from its first parent, which the server refuses because the placement
 * names the chapter it continued. The first parent is the first edge listed for a chapter, the
 * order the graph is read in. Chapter 1 has no parent, so no edge above it.
 */
export function storylineInsertableEdges(graph: {
  chapters: { chapterId: number; viaPlacement: boolean }[];
  edges: { chapterId: number; parentChapterId: number }[];
}) {
  const viaPlacement = new Set(
    graph.chapters.flatMap((c) => (c.viaPlacement ? [c.chapterId] : []))
  );
  const seen = new Set<number>();
  const insertable = new Set<string>();
  for (const { chapterId, parentChapterId } of graph.edges) {
    const first = !seen.has(chapterId);
    seen.add(chapterId);
    if (!(first && viaPlacement.has(chapterId))) insertable.add(`${parentChapterId}:${chapterId}`);
  }
  return insertable;
}

/**
 * The lane layout of a storyline graph, and for each chapter the name and link the chapters list
 * shows. Both follow the route the layout draws to the chapter, so the number in an untitled
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
  /**
   * Before the first row of the ways on from `chapterId`. `canon` when it is on the canon path (its
   * number is then the canon chapter's); otherwise `author` wrote the branch chapter that forks.
   */
  | {
      kind: 'fork';
      chapterId: number;
      number: number;
      paths: number;
      canon: boolean;
      author: string | null;
      lane: number;
    }
  /** Before a chapter where `joining` other paths arrive; `authors` wrote the chapters they leave. */
  | { kind: 'rejoin'; chapterId: number; joining: number; authors: string[]; lane: number };

type LaneListNode = {
  chapterId: number;
  row: number;
  lane: number;
  number: number;
  chapter: { post: { username: string | null } | null };
};
type LaneListLink = Pick<
  StorylineLanes['links'][number],
  'parentChapterId' | 'chapterId' | 'from' | 'to' | 'runLane' | 'lane'
>;

/**
 * The storyline page's chapters list: per row its canon chapter and the chapters of other paths in
 * their lanes, and before it the bands where the story forks and where a path joins back.
 *
 * The canon column is `canon` (the canon path, in order), not the layout's lane 0: the layout hands
 * lane 0 on once the canon path ends, so a later branch chapter there moves to a lane of its own.
 * Without a map, or with one that does not lay the whole canon path down lane 0 (a capped graph
 * can cut canon chapters, or keep a later one reached by a shorter branch), the canon path alone,
 * with a band wherever it forks.
 */
export function buildStorylineLaneList<N extends LaneListNode>(
  fullMap: { layout: Pick<StorylineLanes, 'rows' | 'lanes' | 'links'>; nodes: N[] } | null,
  canon: (N & { chapter: { childCount?: number } })[]
) {
  const canonIds = new Set(canon.map((c) => c.chapterId));
  const laneZero = new Set(fullMap?.nodes.flatMap((n) => (n.lane === 0 ? [n.chapterId] : [])));
  const map = fullMap && canon.every((c) => laneZero.has(c.chapterId)) ? fullMap : null;
  const mapNodes = map?.nodes ?? [];
  const mapLinks = map?.layout.links ?? [];
  const isCanonCell = (chapterId: number) => canonIds.has(chapterId);
  const spare = map?.layout.lanes ?? 1;
  const laneOf = new Map<number, number>();
  for (const node of mapNodes)
    laneOf.set(
      node.chapterId,
      storylineDisplayLane({ lanes: spare }, node, isCanonCell(node.chapterId))
    );

  const nodes = map
    ? mapNodes.map((n) => ({ ...n, lane: laneOf.get(n.chapterId) as number }))
    : canon.map((n, row) => ({ ...n, row, lane: 0 }));
  const parentCount = new Map<number, number>();
  for (const link of mapLinks)
    parentCount.set(link.chapterId, (parentCount.get(link.chapterId) ?? 0) + 1);
  const links: LaneListLink[] = mapLinks.map((link) => {
    const canonLink = isCanonCell(link.parentChapterId) && isCanonCell(link.chapterId);
    const run = link.runLane === 0 && !canonLink ? spare : link.runLane;
    const from = { ...link.from, lane: laneOf.get(link.parentChapterId) as number };
    const to = { ...link.to, lane: laneOf.get(link.chapterId) as number };
    const fork = parentCount.get(link.chapterId) === 1;
    return { ...link, from, to, runLane: run, lane: run ?? (fork ? to.lane : from.lane) };
  });
  const lanes = Math.max(
    1,
    ...nodes.map((n) => n.lane + 1),
    ...links.map((l) => (l.runLane ?? 0) + 1)
  );

  const rows = Array.from({ length: map ? map.layout.rows : canon.length }, (_, row) => ({
    row,
    canon: null as N | null,
    branches: [] as N[],
    bands: [] as StorylineLaneBand[],
  }));
  for (const node of nodes) {
    if (node.lane === 0) rows[node.row].canon = node;
    else rows[node.row].branches.push(node);
  }
  for (const row of rows) row.branches.sort((a, b) => a.lane - b.lane);
  const byId = new Map(nodes.map((n) => [n.chapterId, n]));

  const out = new Map<number, LaneListLink[]>();
  const into = new Map<number, LaneListLink[]>();
  for (const link of links) {
    out.set(link.parentChapterId, [...(out.get(link.parentChapterId) ?? []), link]);
    into.set(link.chapterId, [...(into.get(link.chapterId) ?? []), link]);
  }

  const forks: { row: number; band: StorylineLaneBand }[] = [];
  const fork = (parent: N, paths: number, row: number, lane: number) =>
    forks.push({
      row,
      band: {
        kind: 'fork',
        chapterId: parent.chapterId,
        number: parent.number,
        paths,
        canon: isCanonCell(parent.chapterId),
        author: parent.chapter.post?.username ?? null,
        lane,
      },
    });
  if (map)
    for (const [chapterId, outLinks] of out) {
      const parent = byId.get(chapterId);
      if (!parent || outLinks.length < 2) continue;
      const parentLane = laneOf.get(chapterId) as number;
      const away = outLinks.find((l) => l.to.lane !== parentLane);
      fork(
        parent,
        outLinks.length,
        Math.min(...outLinks.map((l) => l.to.row)),
        parentLane === 0 ? away?.lane ?? 0 : parentLane
      );
    }
  else
    canon.forEach((c, i) => {
      const paths = c.chapter.childCount ?? 0;
      if (paths > 1 && i + 1 < canon.length) fork(c, paths, i + 1, 1);
    });

  const rejoins: { row: number; band: StorylineLaneBand }[] = [];
  const layoutLane = new Map(mapNodes.map((n) => [n.chapterId, n.lane]));
  const layoutLink = new Map(mapLinks.map((l) => [`${l.parentChapterId}:${l.chapterId}`, l]));
  for (const [chapterId, inLinks] of into) {
    const node = byId.get(chapterId);
    if (!node || inLinks.length < 2) continue;
    // A link arrives in the lane it runs down, else its parent's; judged in the layout's own lanes,
    // where the line that carries on into the chapter shares its lane.
    const joining = inLinks.filter((l) => {
      const laid = layoutLink.get(`${l.parentChapterId}:${l.chapterId}`);
      return laid && (laid.runLane ?? laid.from.lane) !== layoutLane.get(chapterId);
    });
    const from = joining.length ? joining : inLinks.slice(1);
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

  /** The canon chapter each way on from a canon fork leaves: its share of readers is shown there. */
  const canonForkOf = new Map<number, number>();
  for (const [parentId, outLinks] of out)
    if (outLinks.length > 1 && isCanonCell(parentId))
      for (const l of outLinks) canonForkOf.set(l.chapterId, parentId);

  return { rows, links, lanes, canonForkOf };
}
