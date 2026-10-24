import { Text } from '@mantine/core';
import { IconGitFork, IconGitMerge, IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { openStorylineContinueModal } from '~/components/Storyline/continue/openStorylineContinueModal';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { StorylineLaneBand } from '~/components/Storyline/storyline-lane-map.utils';
import {
  buildCanonLane,
  buildStorylineLaneList,
  buildStorylineLaneMap,
  laneColor,
  storylineInsertableEdges,
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
import { StorylineRoleChip, StorylineShareChip } from '~/components/Storyline/StorylineChips';
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

/** Rows are fixed-height so branch lanes line up with the canon rows. */
const SIZES = {
  compact: { canon: 84, branch: 52, laneWidth: 64, row: 121, band: 30, visibleLanes: 2 },
  wide: { canon: 112, branch: 72, laneWidth: 124, row: 156, band: 30, visibleLanes: 2 },
};
const RATIO = 5 / 4;

export function StorylineChapterLanes({ storyline }: { storyline: Storyline }) {
  const compact = !!useIsMobile({ type: 'media' });
  const size = compact ? SIZES.compact : SIZES.wide;
  const isOwner = storyline.viewerRole === 'owner';
  // The owner's graph also says which edges refuse an insert, so a straight story reads it too.
  const { data: graph } = useStorylineGraph(storyline.id, {
    enabled: storylineMayBranch(storyline) || isOwner,
  });
  const insertable = useMemo(
    () => (isOwner && graph ? storylineInsertableEdges(graph) : null),
    [isOwner, graph]
  );
  const map = useMemo(() => (graph ? buildStorylineLaneMap(graph) : null), [graph]);
  const canonById = useMemo(
    () => new Map(storyline.mainPath.map((c) => [c.chapterId, c])),
    [storyline.mainPath]
  );
  const collaboratorIds = useMemo(
    () => new Set(storyline.collaborators.map((c) => c.id)),
    [storyline.collaborators]
  );

  const { rows, links, lanes, canonForkOf } = useMemo(
    () =>
      buildStorylineLaneList(
        map as { layout: NonNullable<typeof map>['layout']; nodes: LaneNode[] } | null,
        buildCanonLane(storyline.mainPath) as (LaneNode & { chapter: CanonChapter })[]
      ),
    [map, storyline.mainPath]
  );

  const { tops, height, bandYs } = useMemo(() => {
    let y = 0;
    const bandYs = new Map<string, number>();
    const tops = rows.map((row) => {
      const bands = y;
      row.bands.forEach((band, b) =>
        bandYs.set(`${band.kind}:${band.chapterId}`, bands + b * size.band + size.band / 2)
      );
      y += row.bands.length * size.band;
      const top = y;
      y += size.row;
      return { bands, top };
    });
    return { tops, height: y, bandYs };
  }, [rows, size]);

  const branchLanes = lanes - 1;
  const at = ({ lane, row }: StorylineLanePoint) => ({
    x: lane === 0 ? 0 : (lane - 1) * size.laneWidth + size.laneWidth / 2,
    y: (tops[row]?.top ?? 0) + size.row / 2,
  });
  // Canon is outside the branch area, so its links attach at the edge, in the band that labels
  // the fork or the join.
  const linkPath = (link: (typeof links)[number]) =>
    storylineLanePath(link, (point) => {
      const band =
        point === link.from && point.lane === 0
          ? bandYs.get(`fork:${link.parentChapterId}`)
          : point === link.to && point.lane === 0
          ? bandYs.get(`rejoin:${link.chapterId}`)
          : undefined;
      return band === undefined ? at(point) : { x: 0, y: band };
    });
  const canonRows = rows.flatMap((r, i) => (r.canon ? [i] : []));
  const insertSlots = insertable
    ? canonRows.flatMap((row, n) => {
        const parent = rows[row].canon;
        const child = rows[canonRows[n + 1]]?.canon;
        const parentPostId = parent?.chapter.post?.id;
        if (!parent || !child || !parentPostId) return [];
        if (!insertable.has(`${parent.chapterId}:${child.chapterId}`)) return [];
        return [
          {
            parentChapterId: parent.chapterId,
            childChapterId: child.chapterId,
            parentPostId,
            // Halfway along the rail between one chapter's number and the next's.
            y: (tops[row].top + 26 + tops[canonRows[n + 1]].top + 2) / 2,
          },
        ];
      })
    : [];

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
                  forkId={canonForkOf.get(row.canon.chapterId)}
                  collaboratorIds={collaboratorIds}
                  size={size}
                  top={tops[i].top}
                />
              ) : null
            )}
          </ol>
          {insertSlots.map((slot) => (
            <InsertHere key={`${slot.parentChapterId}:${slot.childChapterId}`} {...slot} />
          ))}
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
                  // Canon-to-canon links are drawn by the canon rail.
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
                      forkId={canonForkOf.get(node.chapterId)}
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

function InsertHere({
  parentChapterId,
  childChapterId,
  parentPostId,
  y,
}: {
  parentChapterId: number;
  childChapterId: number;
  parentPostId: number;
  y: number;
}) {
  const [active, setActive] = useState(false);
  return (
    <div
      className="absolute left-0 z-10 flex h-8 w-9 -translate-y-1/2 items-center"
      style={{ top: y }}
      onPointerEnter={(e) => e.pointerType !== 'touch' && setActive(true)}
      onPointerLeave={() => setActive(false)}
      data-testid="storyline-insert-slot"
    >
      <button
        type="button"
        aria-label="Insert a chapter here"
        onFocus={() => setActive(true)}
        onBlur={() => setActive(false)}
        onClick={() =>
          openStorylineContinueModal({
            parentPostId,
            parentChapterId,
            insertBeforeChapterId: childChapterId,
          })
        }
        className={clsx(
          'flex h-8 cursor-pointer items-center gap-1 rounded-full border border-solid border-[var(--mantine-color-blue-6)] bg-white px-1 py-0 text-xs font-bold text-[var(--mantine-color-blue-6)] dark:bg-dark-6',
          !active && '[@media(hover:hover)]:opacity-0'
        )}
      >
        <IconPlus size={16} aria-hidden />
        {active && <span className="whitespace-nowrap pr-1.5">Insert here</span>}
      </button>
    </div>
  );
}

function CanonStop({
  node,
  canon,
  forkId,
  collaboratorIds,
  size,
  top,
}: {
  node: LaneNode;
  /** The canon fork this chapter is a way on from, whose reader split it shows. */
  forkId: number | undefined;
  /** The same chapter from the canon path, which carries its author for the avatar. */
  canon: CanonChapter | undefined;
  collaboratorIds: Set<number>;
  size: (typeof SIZES)['wide'];
  top: number;
}) {
  const post = canon?.post ?? node.chapter.post;
  const link = node.href ? { href: node.href, read: node.read } : null;
  const share = useForkShare(forkId, node.chapterId);
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
            >
              <ShareChip percent={share} />
            </StorylineThumb>
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
              {share !== null && <span className="sr-only">, {share}% of readers</span>}
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
  forkId,
  collaboratorIds,
  size,
  compact,
  left,
  top,
}: {
  node: LaneNode;
  forkId: number | undefined;
  collaboratorIds: Set<number>;
  size: (typeof SIZES)['wide'];
  compact: boolean;
  left: number;
  top: number;
}) {
  const { post } = node.chapter;
  const tile = { width: size.branch, height: size.branch * RATIO };
  const share = useForkShare(forkId, node.chapterId);
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
          aria-label={share === null ? node.name : `${node.name}, ${share}% of readers`}
          title={compact ? node.name : undefined}
          className="group flex flex-col items-center text-inherit no-underline"
        >
          <span
            className="block overflow-hidden rounded-lg border-2 border-solid bg-gray-0 shadow-sm dark:bg-dark-6"
            style={{ ...tile, borderColor: laneColor(node.lane) }}
          >
            <StorylineThumb image={node.chapter.firstImage} width={size.branch} ratio="4/5">
              <ShareChip percent={share} />
            </StorylineThumb>
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
            {band.canon
              ? `${compact ? 'Forks' : 'The story forks'} after ch ${band.number}`
              : `${band.author ? `${band.author}'s path` : 'A path'} forks`}{' '}
            · {band.paths} paths
          </span>
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

/** A way on's share of readers at its fork, once enough readers have chosen. */
function useForkShare(forkId: number | undefined, chapterId: number) {
  const { data: shares } = useStorylineForkShares(forkId);
  return forkId ? getForkShare(shares, chapterId)?.percent ?? null : null;
}

function ShareChip({ percent }: { percent: number | null }) {
  if (percent === null) return null;
  return <StorylineShareChip percent={percent} className="absolute bottom-1 right-1" />;
}
