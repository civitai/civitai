import type { StorylineEdge } from '~/shared/utils/storyline-graph';

export type StorylineLaneEdge = StorylineEdge & { canon: boolean };
export type StorylineLanePoint = { row: number; lane: number };
export type StorylineLaneNode = StorylineLanePoint & { chapterId: number };
export type StorylineLaneLink = {
  parentChapterId: number;
  chapterId: number;
  from: StorylineLanePoint;
  to: StorylineLanePoint;
  /** Where the line runs straight down between the two, when they are more than a row apart. */
  runLane: number | null;
  /** The lane the link belongs to, for its colour: the branch it opens, runs in or arrives from. */
  lane: number;
};
export type StorylineLanes = {
  nodes: StorylineLaneNode[];
  links: StorylineLaneLink[];
  rows: number;
  lanes: number;
};

const linkKey = (parentId: number, childId: number) => `${parentId}:${childId}`;

/**
 * Lays a storyline out as lanes that fork and rejoin, for the Story page map. `edges` come oldest
 * first; a chapter not reached from `rootId` is left out, and so is any edge touching one.
 *
 * - Row: the longest route from chapter 1, so a rejoin sits below the longer of its branches.
 * - Lane: chapter 1 and its canon chain hold lane 0, and each chapter's canon child (else its
 *   oldest) carries its lane on. Any other child opens the lowest free lane. A rejoin takes the
 *   lowest lane its branches arrive in, and a lane is free again once its branch rejoins or ends.
 * - A link more than a row long runs down its own lane: the parent's when the child carries it
 *   on, else a lane opened for the run.
 */
export function layoutStorylineLanes(
  rootId: number,
  chapterIds: number[],
  edges: StorylineLaneEdge[]
): StorylineLanes {
  const known = new Set(chapterIds);
  const childEdges = new Map<number, StorylineLaneEdge[]>();
  const parentsOf = new Map<number, number[]>();
  for (const edge of edges) {
    if (!known.has(edge.chapterId) || !known.has(edge.parentChapterId)) continue;
    childEdges.set(edge.parentChapterId, [...(childEdges.get(edge.parentChapterId) ?? []), edge]);
    parentsOf.set(edge.chapterId, [...(parentsOf.get(edge.chapterId) ?? []), edge.parentChapterId]);
  }
  if (!known.has(rootId)) return { nodes: [], links: [], rows: 0, lanes: 0 };

  // Reached from the root, then rows by longest route (Kahn over the reached part only).
  const reached = new Set([rootId]);
  const stack = [rootId];
  while (stack.length)
    for (const { chapterId } of childEdges.get(stack.pop() as number) ?? [])
      if (!reached.has(chapterId)) {
        reached.add(chapterId);
        stack.push(chapterId);
      }
  const parents = (id: number) => (parentsOf.get(id) ?? []).filter((p) => reached.has(p));
  const children = (id: number) => childEdges.get(id) ?? [];

  const row = new Map<number, number>([[rootId, 0]]);
  const waiting = new Map([...reached].map((id) => [id, parents(id).length]));
  const order: number[] = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift() as number;
    order.push(id);
    for (const { chapterId } of children(id)) {
      row.set(chapterId, Math.max(row.get(chapterId) ?? 0, (row.get(id) as number) + 1));
      const left = (waiting.get(chapterId) as number) - 1;
      waiting.set(chapterId, left);
      if (left === 0) queue.push(chapterId);
    }
  }
  const byRow: number[][] = [];
  for (const id of order) (byRow[row.get(id) as number] ??= []).push(id);

  const taken = new Map<number, Set<number>>();
  const isFree = (lane: number, r: number) => !taken.get(r)?.has(lane);
  const take = (lane: number, r: number) => {
    if (!taken.has(r)) taken.set(r, new Set());
    taken.get(r)?.add(lane);
  };
  const lowestFree = (from: number, to: number) => {
    for (let lane = 0; ; lane++) {
      let free = true;
      for (let r = from; r <= to && free; r++) free = isFree(lane, r);
      if (free) return lane;
    }
  };

  const lane = new Map<number, number>([[rootId, 0]]);
  const runLane = new Map<string, number>();
  const heirOf = (id: number) => {
    const out = children(id);
    return (out.find((e) => e.canon) ?? out[0])?.chapterId;
  };
  // The lane each link arrives in at its child: its run's lane, else its parent's.
  const arrivesIn = (parentId: number, childId: number) =>
    runLane.get(linkKey(parentId, childId)) ?? (lane.get(parentId) as number);

  byRow.forEach((ids, r) => {
    // Rejoins first, each in the lowest free lane one of its branches arrives in; then the other
    // children, each opening a lane. Carried-on children were placed by their parent already.
    const rejoins = ids
      .filter((id) => !lane.has(id) && parents(id).length > 1)
      .map((id) => ({ id, arriving: parents(id).map((p) => arrivesIn(p, id)) }))
      .sort((a, b) => Math.min(...a.arriving) - Math.min(...b.arriving) || a.id - b.id);
    for (const { id, arriving } of rejoins) {
      const own = [...arriving].sort((a, b) => a - b).find((l) => isFree(l, r));
      lane.set(id, own ?? lowestFree(r, r));
      take(lane.get(id) as number, r);
    }
    for (const id of ids) {
      if (lane.has(id)) {
        if (id === rootId) take(0, r);
        continue;
      }
      lane.set(id, lowestFree(r, r));
      take(lane.get(id) as number, r);
    }

    // Reserve what leaves this row: each chapter's carried-on child, or the run down its own lane
    // to a carried-on rejoin further down; then a lane for each other run.
    const others: { parentId: number; childId: number }[] = [];
    for (const id of ids) {
      const own = lane.get(id) as number;
      const heir = heirOf(id);
      for (const { chapterId } of children(id)) {
        const to = row.get(chapterId) as number;
        if (chapterId === heir && parents(chapterId).length === 1) {
          lane.set(chapterId, own);
          take(own, r + 1);
        } else if (to > r + 1) {
          if (chapterId !== heir) {
            others.push({ parentId: id, childId: chapterId });
            continue;
          }
          runLane.set(linkKey(id, chapterId), own);
          for (let x = r + 1; x < to; x++) take(own, x);
        }
      }
    }
    for (const { parentId, childId } of others) {
      const to = row.get(childId) as number;
      const run = lowestFree(r + 1, to - 1);
      runLane.set(linkKey(parentId, childId), run);
      for (let x = r + 1; x < to; x++) take(run, x);
    }
  });

  const at = (id: number) => ({ row: row.get(id) as number, lane: lane.get(id) as number });
  const nodes = order.map((chapterId) => ({ chapterId, ...at(chapterId) }));
  const links = edges
    .filter((e) => reached.has(e.chapterId) && reached.has(e.parentChapterId))
    .map(({ parentChapterId, chapterId }) => {
      const from = at(parentChapterId);
      const to = at(chapterId);
      const run = runLane.get(linkKey(parentChapterId, chapterId)) ?? null;
      const fork = parents(chapterId).length === 1;
      return {
        parentChapterId,
        chapterId,
        from,
        to,
        runLane: run,
        lane: run ?? (fork ? to.lane : from.lane),
      };
    });
  const lanes = Math.max(0, ...nodes.map((n) => n.lane), ...links.map((l) => l.runLane ?? 0)) + 1;
  return { nodes, links, rows: byRow.length, lanes };
}

/**
 * The route from chapter 1 to `chapterId` as the map draws it: up the line that arrives in the
 * chapter's own lane, else its oldest link, at each step.
 */
export function storylineLaneRoute(layout: StorylineLanes, chapterId: number) {
  const laneOf = new Map(layout.nodes.map((n) => [n.chapterId, n.lane]));
  const incoming = new Map<number, StorylineLaneLink[]>();
  for (const link of layout.links)
    incoming.set(link.chapterId, [...(incoming.get(link.chapterId) ?? []), link]);
  if (!laneOf.has(chapterId)) return [];

  const route = [chapterId];
  const seen = new Set(route);
  for (let id = chapterId; ; ) {
    const links = incoming.get(id) ?? [];
    const next = (links.find((l) => l.lane === laneOf.get(id)) ?? links[0])?.parentChapterId;
    if (next === undefined || seen.has(next)) return route.reverse();
    route.push(next);
    seen.add(next);
    id = next;
  }
}

/**
 * The SVG path of a link, given where a lane and row sit: straight within a lane, curving across
 * lanes over one row's gap, next to the parent when a run follows and next to the child after one.
 */
export function storylineLanePath(
  link: Pick<StorylineLaneLink, 'from' | 'to' | 'runLane'>,
  at: (point: StorylineLanePoint) => { x: number; y: number }
) {
  const points =
    link.runLane === null
      ? [link.from, link.to]
      : [
          link.from,
          { lane: link.runLane, row: link.from.row + 1 },
          { lane: link.runLane, row: link.to.row - 1 },
          link.to,
        ];
  const xy = points.map(at);
  return xy.slice(1).reduce((d, q, i) => {
    const p = xy[i];
    if (p.x === q.x && p.y === q.y) return d;
    if (p.x === q.x) return `${d} L ${q.x} ${q.y}`;
    const mid = (p.y + q.y) / 2;
    return `${d} C ${p.x} ${mid} ${q.x} ${mid} ${q.x} ${q.y}`;
  }, `M ${xy[0].x} ${xy[0].y}`);
}
