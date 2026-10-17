import { Text, Tooltip } from '@mantine/core';
import { useMemo } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { buildStorylineLaneMap } from '~/components/Storyline/storyline-lane-map.utils';
import { useStorylineGraph } from '~/components/Storyline/storyline.queries';
import { StorylineChapterImage } from '~/components/Storyline/StorylineChapterImage';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';
import type { RouterOutput } from '~/types/router';
import type { StorylineLanePoint } from '~/shared/utils/storyline-lanes';
import { storylineLanePath } from '~/shared/utils/storyline-lanes';

type GraphChapter = RouterOutput['storyline']['getGraph']['chapters'][number];
type LaneMap = NonNullable<ReturnType<typeof buildStorylineLaneMap<GraphChapter>>>;
type LaneMapNode = LaneMap['nodes'][number];

const LANE_WIDTH = 72;
const NODE_WIDTH = 52;
const NODE_HEIGHT = (NODE_WIDTH * 5) / 4;
const ROW_HEIGHT = 84;
const ROW_NAMES = 3;
const LANE_COLORS = ['blue', 'grape', 'teal', 'orange', 'pink', 'lime', 'cyan', 'yellow'];

const laneColor = (lane: number) =>
  `var(--mantine-color-${LANE_COLORS[lane % LANE_COLORS.length]}-6)`;
const at = ({ lane, row }: StorylineLanePoint) => ({
  x: lane * LANE_WIDTH + LANE_WIDTH / 2,
  y: row * ROW_HEIGHT + ROW_HEIGHT / 2,
});

export function useStorylineLaneMap(storylineId: number, options: { enabled: boolean }) {
  const { data, isLoading } = useStorylineGraph(storylineId, options);
  const map = useMemo(() => (data ? buildStorylineLaneMap(data) : null), [data]);
  return { map: map && map.layout.lanes > 1 ? map : null, isLoading };
}

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
        {/* aria-hidden: each node above already carries its name. */}
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
  const position = { left: x - NODE_WIDTH / 2, top: y - NODE_HEIGHT / 2, width: NODE_WIDTH };
  return (
    <li data-testid="storyline-lane-node">
      <Tooltip label={node.name} withinPortal openDelay={200}>
        {node.href ? (
          <Link
            href={node.href}
            aria-label={node.name}
            className="absolute block overflow-hidden rounded-lg border-2 border-solid bg-gray-0 shadow-sm dark:bg-dark-6"
            style={{ ...position, borderColor: laneColor(node.lane) }}
          >
            <StorylineThumb image={node.chapter.firstImage} width={NODE_WIDTH} ratio="4/5" />
          </Link>
        ) : (
          <div role="img" aria-label={node.name} className="absolute" style={position}>
            <StorylineChapterImage image={null} hidden className="aspect-[4/5] w-full !p-0" />
          </div>
        )}
      </Tooltip>
    </li>
  );
}
