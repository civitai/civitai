import { Text, Tooltip } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import {
  getStorylineChapterName,
  routeVia,
  storylineReadHref,
} from '~/components/Storyline/storyline-mode.utils';
import { useStorylineGraph } from '~/components/Storyline/storyline.queries';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';
import type { RouterOutput } from '~/types/router';
import type { StorylineLanePoint } from '~/shared/utils/storyline-lanes';
import {
  layoutStorylineLanes,
  storylineLanePath,
  storylineLaneRoute,
} from '~/shared/utils/storyline-lanes';

type StorylineGraph = RouterOutput['storyline']['getGraph'];
type LaneMap = NonNullable<ReturnType<typeof buildLaneMap>>;
type LaneMapNode = LaneMap['nodes'][number];

const LANE_WIDTH = 72;
const NODE_WIDTH = 52;
const ROW_HEIGHT = 84;
/** Names listed beside a row; a wider row says how many more. */
const ROW_NAMES = 3;
/** Lane 0 is the canon route; the rest cycle. */
const LANE_COLORS = ['blue', 'grape', 'teal', 'orange', 'pink', 'lime', 'cyan', 'yellow'];

const laneColor = (lane: number) =>
  `var(--mantine-color-${LANE_COLORS[lane % LANE_COLORS.length]}-6)`;
const at = ({ lane, row }: StorylineLanePoint) => ({
  x: lane * LANE_WIDTH + LANE_WIDTH / 2,
  y: row * ROW_HEIGHT + ROW_HEIGHT / 2,
});

function buildLaneMap(graph: StorylineGraph) {
  if (!graph.rootChapterId) return null;
  const layout = layoutStorylineLanes(
    graph.rootChapterId,
    graph.chapters.map((c) => c.chapterId),
    graph.edges
  );
  const chapterById = new Map(graph.chapters.map((c) => [c.chapterId, c]));
  const parentCount = new Map<number, number>();
  for (const link of layout.links)
    parentCount.set(link.chapterId, (parentCount.get(link.chapterId) ?? 0) + 1);

  const nodes = layout.nodes.flatMap((node) => {
    const chapter = chapterById.get(node.chapterId);
    if (!chapter) return [];
    const route = storylineLaneRoute(layout, node.chapterId).map((chapterId) => ({
      chapterId,
      parentCount: parentCount.get(chapterId),
    }));
    return {
      ...node,
      chapter,
      // Numbered by the route the map lays it on, its longest.
      name: getStorylineChapterName({ ...chapter, depth: node.row }, { withAuthor: true }),
      href: chapter.firstImage
        ? storylineReadHref({
            imageId: chapter.firstImage.id,
            chapterId: node.chapterId,
            via: routeVia(route),
          })
        : chapter.post
        ? `/posts/${chapter.post.id}`
        : null,
    };
  });
  return { layout, nodes, truncated: graph.truncated };
}

/** The story's lane map, once read; null while there is none or the story never forks. */
export function useStorylineLaneMap(storylineId: number, options: { enabled: boolean }) {
  const { data, isLoading } = useStorylineGraph(storylineId, options);
  const map = useMemo(() => (data ? buildLaneMap(data) : null), [data]);
  return { map: map && map.layout.lanes > 1 ? map : null, isLoading };
}

/**
 * The whole story as lanes: the canon route straight down the first, each branch in a lane of its
 * own beside it, curving out where it forks and back in where it rejoins. Each chapter opens in
 * the reader on the route the map draws to it.
 */
export function StorylineLaneMap({ map }: { map: LaneMap }) {
  const { layout, nodes, truncated } = map;
  const width = layout.lanes * LANE_WIDTH;
  const height = layout.rows * ROW_HEIGHT;
  const rows = Array.from({ length: layout.rows }, (_, row) =>
    nodes.filter((n) => n.row === row).sort((a, b) => a.lane - b.lane)
  );

  return (
    <div data-testid="storyline-lane-map">
      <div className="flex items-start gap-3 overflow-x-auto">
        <div className="relative shrink-0" style={{ width, height }}>
          <svg aria-hidden width={width} height={height} className="absolute inset-0">
            {layout.links.map((link) => (
              <path
                key={`${link.parentChapterId}:${link.chapterId}`}
                d={storylineLanePath(link, at)}
                fill="none"
                stroke={laneColor(link.lane)}
                strokeWidth={3}
                strokeLinecap="round"
                opacity={0.7}
              />
            ))}
          </svg>
          <ol aria-label="Story map" className="m-0 list-none p-0">
            {nodes.map((node) => (
              <LaneNode key={node.chapterId} node={node} />
            ))}
          </ol>
        </div>
        {/* The names by row, to read the map at a glance; each chapter above carries its own. */}
        <ol aria-hidden className="m-0 min-w-[140px] flex-1 list-none p-0">
          {rows.map((row, i) => (
            <li
              key={i}
              className="flex flex-col justify-center gap-0.5"
              style={{ height: ROW_HEIGHT }}
            >
              {row.slice(0, ROW_NAMES).map((node) => (
                <Text
                  key={node.chapterId}
                  size="xs"
                  c={node.chapter.post ? undefined : 'dimmed'}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  <span
                    className="inline-block size-2 shrink-0 rounded-full"
                    style={{ background: laneColor(node.lane) }}
                  />
                  <span className="truncate">{node.name}</span>
                </Text>
              ))}
              {row.length > ROW_NAMES && (
                <Text size="xs" c="dimmed">
                  +{row.length - ROW_NAMES} more
                </Text>
              )}
            </li>
          ))}
        </ol>
      </div>
      {truncated && (
        <Text size="xs" c="dimmed" mt="xs">
          Showing the first {nodes.length} chapters.
        </Text>
      )}
    </div>
  );
}

function LaneNode({ node }: { node: LaneMapNode }) {
  const { x, y } = at(node);
  const style = {
    left: x - NODE_WIDTH / 2,
    // A 4:5 thumb, centred on the row.
    top: y - (NODE_WIDTH * 5) / 8,
    width: NODE_WIDTH,
    borderColor: laneColor(node.lane),
  };
  const className =
    'absolute block overflow-hidden rounded-lg border-2 border-solid bg-gray-0 shadow-sm dark:bg-dark-6';
  const thumb = node.chapter.post ? (
    <StorylineThumb image={node.chapter.firstImage} width={NODE_WIDTH} ratio="4/5" />
  ) : (
    <div className="flex aspect-[4/5] items-center justify-center">
      <IconEyeOff size={18} className="text-gray-6 dark:text-dark-2" aria-hidden />
    </div>
  );
  return (
    <li data-testid="storyline-lane-node">
      <Tooltip label={node.name} withinPortal openDelay={200}>
        {node.href ? (
          <Link href={node.href} aria-label={node.name} className={className} style={style}>
            {thumb}
          </Link>
        ) : (
          <div
            role="img"
            aria-label={node.name}
            className={clsx(className, 'border-dashed')}
            style={style}
          >
            {thumb}
          </div>
        )}
      </Tooltip>
    </li>
  );
}
