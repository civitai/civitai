import { Text } from '@mantine/core';
import { IconGitFork, IconGitMerge } from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo } from 'react';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { StorylineLaneBand } from '~/components/Storyline/storyline-lane-map.utils';
import {
  buildCanonLane,
  buildStorylineLaneMap,
  buildStorylineLaneRows,
  storylineMayBranch,
} from '~/components/Storyline/storyline-lane-map.utils';
import {
  getForkShare,
  getStorylineTombstoneLabel,
} from '~/components/Storyline/storyline-mode.utils';
import { storylineChapterLinkProps } from '~/components/Storyline/storyline-read-link';
import {
  useStorylineForkShares,
  useStorylineGraph,
} from '~/components/Storyline/storyline.queries';
import { StorylineRoleChip } from '~/components/Storyline/StorylineChips';
import { StorylineChapterImage } from '~/components/Storyline/StorylineChapterImage';
import { StorylineThumb } from '~/components/Storyline/StorylineThumb';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { RouterOutput } from '~/types/router';
import type { StorylineLanePoint } from '~/shared/utils/storyline-lanes';
import { storylineLanePath } from '~/shared/utils/storyline-lanes';

type Storyline = RouterOutput['storyline']['getById'];
type CanonChapter = Storyline['mainPath'][number];
type GraphChapter = RouterOutput['storyline']['getGraph']['chapters'][number];
type LaneNode = {
  chapterId: number;
  row: number;
  lane: number;
  number: number;
  title: string;
  name: string;
  href: string | null;
  read: Parameters<typeof storylineChapterLinkProps>[0]['read'];
  chapter: GraphChapter | CanonChapter;
};

const LANE_COLORS = ['blue', 'grape', 'teal', 'orange', 'pink', 'lime', 'cyan', 'yellow'];
const laneColor = (lane: number) =>
  `var(--mantine-color-${LANE_COLORS[lane % LANE_COLORS.length]}-6)`;

/** Sizes on a phone and from `sm` up. Rows are fixed so the branch lanes line up with the canon. */
const SIZES = {
  compact: { canon: 84, branch: 52, laneWidth: 64, row: 121, band: 30, visibleLanes: 2 },
  wide: { canon: 112, branch: 72, laneWidth: 136, row: 156, band: 30, visibleLanes: 3 },
};
const RATIO = 5 / 4;

/**
 * The storyline's chapters as lanes: the canon path down the left with big tiles and titles, the
 * other paths in coloured lanes to its right, and a labelled band where the story forks or a path
 * joins back. A story that never forks is the canon lane alone.
 */
export function StorylineChapterLanes({ storyline }: { storyline: Storyline }) {
  const compact = !!useIsMobile({ type: 'media' });
  const size = compact ? SIZES.compact : SIZES.wide;
  const { data: graph } = useStorylineGraph(storyline.id, {
    enabled: storylineMayBranch(storyline),
  });
  const map = useMemo(() => (graph ? buildStorylineLaneMap(graph) : null), [graph]);
  const branched = !!map && map.layout.lanes > 1;
  const canonById = useMemo(
    () => new Map(storyline.mainPath.map((c) => [c.chapterId, c])),
    [storyline.mainPath]
  );
  const collaboratorIds = useMemo(
    () => new Set(storyline.collaborators.map((c) => c.id)),
    [storyline.collaborators]
  );

  // Until the graph arrives (or when there is nothing to branch), the canon path alone.
  const { rows, links, lanes } = useMemo(() => {
    if (map && branched) {
      const nodes = map.nodes as LaneNode[];
      return {
        rows: buildStorylineLaneRows(map.layout, nodes),
        links: map.layout.links,
        lanes: map.layout.lanes,
      };
    }
    const nodes = buildCanonLane(storyline.mainPath) as LaneNode[];
    return {
      rows: buildStorylineLaneRows({ rows: nodes.length, links: [] }, nodes),
      links: [],
      lanes: 1,
    };
  }, [map, branched, storyline.mainPath]);

  // Where each row's bands and its chapters start, top to bottom.
  const { tops, height } = useMemo(() => {
    let y = 0;
    const tops = rows.map((row) => {
      const bands = y;
      y += row.bands.length * size.band;
      const top = y;
      y += size.row;
      return { bands, top };
    });
    return { tops, height: y };
  }, [rows, size]);

  const branchLanes = lanes - 1;
  const at = ({ lane, row }: StorylineLanePoint) => ({
    x: lane === 0 ? 0 : (lane - 1) * size.laneWidth + size.laneWidth / 2,
    y: (tops[row]?.top ?? 0) + size.row / 2,
  });
  // The canon lane sits left of the branch area, so a link to or from it runs out of the band
  // that labels the fork or the join, at the area's edge.
  const bandY = (row: number, chapterId: number) => {
    const index = rows[row]?.bands.findIndex((band) => band.chapterId === chapterId) ?? -1;
    return (tops[row]?.bands ?? 0) + Math.max(index, 0) * size.band + size.band / 2;
  };
  const linkPath = (link: (typeof links)[number]) =>
    storylineLanePath(link, (point) => {
      if (point === link.from && point.lane === 0)
        return { x: 0, y: bandY(link.to.row, link.parentChapterId) };
      if (point === link.to && point.lane === 0)
        return { x: 0, y: bandY(link.to.row, link.chapterId) };
      return at(point);
    });
  const canonRows = rows.flatMap((r, i) => (r.canon ? [i] : []));

  return (
    <div data-testid="storyline-lanes">
      <div className="flex">
        <div className="relative min-w-0 flex-1" style={{ height }}>
          {canonRows.length > 1 && (
            <span
              aria-hidden
              className="absolute left-[11px] w-0.5 bg-[var(--mantine-color-blue-6)] opacity-45"
              style={{
                top: tops[canonRows[0]].top + 12,
                height: tops[canonRows[canonRows.length - 1]].top - tops[canonRows[0]].top,
              }}
            />
          )}
          {rows.map((row, i) => (
            <div key={row.row}>
              {row.bands.map((band, b) => (
                <LaneBand
                  key={`${band.kind}:${band.chapterId}`}
                  band={band}
                  top={tops[i].bands + b * size.band}
                  height={size.band}
                  extend={branchLanes > 0}
                  compact={compact}
                />
              ))}
            </div>
          ))}
          <ol aria-label="Chapters on the canon path" className="m-0 list-none p-0">
            {rows.map((row, i) =>
              row.canon ? (
                <CanonStop
                  key={row.canon.chapterId}
                  node={row.canon}
                  canon={canonById.get(row.canon.chapterId)}
                  collaboratorIds={collaboratorIds}
                  size={size}
                  top={tops[i].top}
                />
              ) : null
            )}
          </ol>
        </div>

        {branchLanes > 0 && (
          <div
            className="shrink-0 overflow-x-auto"
            style={{ width: Math.min(branchLanes, size.visibleLanes) * size.laneWidth }}
          >
            <div className="relative" style={{ width: branchLanes * size.laneWidth, height }}>
              {rows.map((row, i) =>
                row.bands.map((band, b) => (
                  <span
                    key={`${band.kind}:${band.chapterId}`}
                    aria-hidden
                    className="absolute inset-x-0"
                    style={{
                      top: tops[i].bands + b * size.band + 3,
                      height: size.band - 6,
                      background: `color-mix(in srgb, ${laneColor(band.lane)} 14%, transparent)`,
                    }}
                  />
                ))
              )}
              <svg
                aria-hidden
                width={branchLanes * size.laneWidth}
                height={height}
                className="absolute inset-0"
              >
                {links
                  // The canon lane draws its own line; only links that touch a branch lane go here.
                  .filter((l) => l.from.lane || l.to.lane || l.runLane)
                  .map((link) => (
                    <path
                      key={`${link.parentChapterId}:${link.chapterId}`}
                      d={linkPath(link)}
                      fill="none"
                      stroke={laneColor(link.lane)}
                      strokeWidth={3}
                      strokeLinecap="round"
                      opacity={0.7}
                    />
                  ))}
              </svg>
              <ol aria-label="Chapters on other paths" className="m-0 list-none p-0">
                {rows.flatMap((row, i) =>
                  row.branches.map((node) => (
                    <BranchStop
                      key={node.chapterId}
                      node={node}
                      collaboratorIds={collaboratorIds}
                      size={size}
                      compact={compact}
                      left={(node.lane - 1) * size.laneWidth}
                      top={tops[i].top}
                    />
                  ))
                )}
              </ol>
            </div>
          </div>
        )}
      </div>
      {map?.truncated && (
        <Text size="xs" c="dimmed" mt="xs">
          Showing the first {map.nodes.length} chapters.
        </Text>
      )}
    </div>
  );
}

function CanonStop({
  node,
  canon,
  collaboratorIds,
  size,
  top,
}: {
  node: LaneNode;
  /** The same chapter from the canon path, which carries its author for the avatar. */
  canon: CanonChapter | undefined;
  collaboratorIds: Set<number>;
  size: (typeof SIZES)['wide'];
  top: number;
}) {
  const post = canon?.post ?? node.chapter.post;
  const link = node.href ? { href: node.href, read: node.read } : null;
  return (
    <li
      className="absolute inset-x-0 flex gap-3.5 pl-9"
      style={{ top, height: size.row }}
      data-testid="storyline-chapter"
    >
      <span
        aria-hidden
        className={clsx(
          'absolute left-0 top-0.5 flex size-6 items-center justify-center rounded-full text-xs font-extrabold text-white shadow-[0_0_0_4px_var(--mantine-color-gray-0)] dark:shadow-[0_0_0_4px_var(--mantine-color-dark-6)]',
          post ? 'bg-[var(--mantine-color-blue-6)]' : 'bg-gray-5 dark:bg-dark-3'
        )}
      >
        {node.number}
      </span>
      {post && link ? (
        <>
          {/* The title is the link; the picture repeats it for the pointer only. */}
          <Link
            {...storylineChapterLinkProps(link)}
            tabIndex={-1}
            aria-hidden
            className="shrink-0"
            style={{ width: size.canon }}
          >
            <StorylineThumb
              image={node.chapter.firstImage}
              width={size.canon}
              ratio="4/5"
              fluid
              className="rounded-lg"
            />
          </Link>
          <div className="min-w-0 flex-1 pt-0.5">
            {/* An untitled chapter is named by its number, so the eyebrow would only repeat it. */}
            {post.title && (
              <Text size="xs" fw={700} c="dimmed">
                Chapter {node.number}
              </Text>
            )}
            <Text
              component={Link}
              {...storylineChapterLinkProps(link)}
              fw={700}
              lh={1.25}
              lineClamp={2}
              className="text-[15px] hover:underline sm:text-[17px]"
            >
              {node.title}
            </Text>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {canon?.post ? (
                <UserAvatar user={canon.post.user} withUsername linkToProfile size="xs" />
              ) : (
                <Text size="xs" c="dimmed">
                  {post.username}
                </Text>
              )}
              {collaboratorIds.has(post.userId) && <StorylineRoleChip role="endorsed" />}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="shrink-0" style={{ width: size.canon }}>
            <StorylineChapterImage image={null} hidden className="aspect-[4/5] w-full !p-0" />
          </div>
          <Text size="sm" c="dimmed" className="min-w-0 flex-1 pt-0.5">
            {getStorylineTombstoneLabel(node.chapter.tombstone ?? 'deleted')}
          </Text>
        </>
      )}
    </li>
  );
}

function BranchStop({
  node,
  collaboratorIds,
  size,
  compact,
  left,
  top,
}: {
  node: LaneNode;
  collaboratorIds: Set<number>;
  size: (typeof SIZES)['wide'];
  compact: boolean;
  left: number;
  top: number;
}) {
  const { post } = node.chapter;
  const tile = { width: size.branch, height: size.branch * RATIO };
  return (
    <li
      className="absolute flex flex-col items-center"
      style={{
        left,
        width: size.laneWidth,
        top: top + (size.row - tile.height) / 2 - (compact ? 0 : 18),
      }}
      data-testid="storyline-lane-node"
    >
      {node.href ? (
        <Link
          {...storylineChapterLinkProps({ href: node.href, read: node.read })}
          aria-label={node.name}
          title={compact ? node.name : undefined}
          className="group flex flex-col items-center text-inherit no-underline"
        >
          <span
            className="block overflow-hidden rounded-lg border-2 border-solid bg-gray-0 shadow-sm dark:bg-dark-6"
            style={{ ...tile, borderColor: laneColor(node.lane) }}
          >
            <StorylineThumb image={node.chapter.firstImage} width={size.branch} ratio="4/5" />
          </span>
          {!compact && (
            <Text
              size="xs"
              fw={700}
              lh={1.2}
              mt={4}
              lineClamp={2}
              ta="center"
              className="relative bg-gray-0 px-1 group-hover:underline dark:bg-dark-6"
            >
              {node.title}
            </Text>
          )}
        </Link>
      ) : (
        <div role="img" aria-label={node.name} style={tile}>
          <StorylineChapterImage image={null} hidden className="aspect-[4/5] w-full !p-0" />
        </div>
      )}
      {!compact && post && (
        <Text
          size="xs"
          c="dimmed"
          lineClamp={1}
          ta="center"
          className="relative bg-gray-0 px-1 dark:bg-dark-6"
        >
          {post.username}
          {collaboratorIds.has(post.userId) ? ' · endorsed' : ''}
        </Text>
      )}
    </li>
  );
}

function LaneBand({
  band,
  top,
  height,
  extend,
  compact,
}: {
  band: StorylineLaneBand;
  compact: boolean;
  top: number;
  height: number;
  /** The band runs on under the branch lanes, so square its right end there. */
  extend: boolean;
}) {
  const color = laneColor(band.lane);
  return (
    <div
      className={clsx(
        'absolute inset-x-0 flex items-center gap-1.5 overflow-hidden px-2 text-[11px] font-extrabold uppercase tracking-wide',
        extend ? 'rounded-l-md' : 'rounded-md'
      )}
      style={{
        top: top + 3,
        height: height - 6,
        color,
        background: `color-mix(in srgb, ${color} 14%, transparent)`,
      }}
      data-testid={band.kind === 'fork' ? 'storyline-fork' : 'storyline-rejoin'}
    >
      {band.kind === 'fork' ? (
        <>
          <IconGitFork size={14} aria-hidden className="shrink-0" />
          <span className="truncate">
            {compact ? 'Forks' : 'The story forks'} after ch {band.number} · {band.childIds.length}{' '}
            paths
          </span>
          <ForkShares band={band} />
        </>
      ) : (
        <>
          <IconGitMerge size={14} aria-hidden className="shrink-0" />
          <span className="truncate">
            {band.joining === 1 && band.authors.length === 1
              ? `${band.authors[0]}'s path joins here`
              : band.joining === 1
              ? 'A path joins here'
              : `${band.joining} paths join here`}
          </span>
        </>
      )}
    </div>
  );
}

/** The reader split at a fork, in lane order, once enough readers have chosen. */
function ForkShares({ band }: { band: Extract<StorylineLaneBand, { kind: 'fork' }> }) {
  const { data: shares } = useStorylineForkShares(band.chapterId);
  const percents = band.childIds.map((id) => getForkShare(shares, id)?.percent);
  if (percents.some((p) => p === undefined)) return null;
  return <span className="ml-auto shrink-0 tabular-nums">{percents.join('% / ')}%</span>;
}
