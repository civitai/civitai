import { Badge, Text } from '@mantine/core';
import { IconBolt, IconGauge, IconUsers } from '@tabler/icons-react';
import clsx from 'clsx';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { formatDownloadEtaShort } from '~/components/ResourceLoad/download-eta';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
import { formatBytes, numberWithCommas } from '~/utils/number-helpers';

/** Keyed by the orchestrator's `Priority`, which is not wording to put in front of a buyer. */
const LANES = [
  { key: 'low', label: 'Standard', pill: { label: 'Free', color: 'green' } },
  { key: 'normal', label: 'Priority', pill: { label: 'Members only', color: 'violet' } },
  { key: 'high', label: 'Express', pill: { label: 'Boost', color: 'yellow' } },
] as const;

export const BOOST_LANE_LABEL = 'Express';

export function downloadLaneLabel(lane: string | null | undefined) {
  if (!lane) return undefined;
  return LANES.find((x) => x.key === lane)?.label ?? lane;
}

/**
 * A lane's per-stream cap as the orchestrator reports it. `null` is uncapped — the high lane, which
 * is what a boost buys — and `undefined` is not reported.
 */
export function formatLaneSpeed(rateLimitBytesPerSecond: number | null | undefined) {
  if (rateLimitBytesPerSecond === undefined) return undefined;
  if (rateLimitBytesPerSecond === null) return 'no speed cap';
  return `up to ${Math.round((rateLimitBytesPerSecond * 8) / 1_000_000)} Mbps`;
}

export type DownloadLanePlacement = {
  lane: string;
  /** Downloads ahead, or null before this one is queued. */
  queuePosition?: number | null;
  transferring?: boolean;
  etaSeconds?: number | null;
  boostedEtaSeconds?: number | null;
  rateLimitBytesPerSecond?: number | null;
  totalBytes: number;
  boostFee?: number | null;
};

export function DownloadLanes({ placement }: { placement?: DownloadLanePlacement }) {
  return (
    <div className="flex flex-col">
      <div className="px-1 pb-2">
        <Text size="sm" fw={700}>
          Why this takes time
        </Text>
        <Text size="xs" c="dimmed" mt={4}>
          Resources have to be downloaded into the generator before it can run. They queue in a
          lane, and the lane sets how fast they move.
        </Text>
      </div>

      <div className="flex flex-col gap-1">
        {LANES.map((lane) => {
          const here = placement?.lane === lane.key;
          const buy = !!placement && lane.key === 'high' && !here;
          const eta = here ? placement.etaSeconds : buy ? placement.boostedEtaSeconds : undefined;
          // Only the viewer's own lane reports its cap; the high lane is uncapped by definition.
          const speed = here
            ? formatLaneSpeed(placement.rateLimitBytesPerSecond)
            : lane.key === 'high'
            ? formatLaneSpeed(null)
            : undefined;
          return (
            <div
              key={lane.key}
              className={clsx(
                'flex items-center justify-between gap-3 rounded-md px-2.5 py-2',
                here && 'bg-gray-1 dark:bg-white/5',
                buy && 'bg-yellow-5/10'
              )}
            >
              <div className="min-w-0">
                <div
                  className={clsx(
                    'flex flex-wrap items-center gap-1.5 text-xs font-semibold',
                    buy && 'text-yellow-6'
                  )}
                >
                  {lane.label}
                  {here && (
                    <Badge size="xs" color="gray" variant="light">
                      You are here
                    </Badge>
                  )}
                  <Badge size="xs" color={lane.pill.color} variant="light">
                    {lane.pill.label}
                  </Badge>
                </div>
                <div className="text-dimmed mt-0.5 flex flex-wrap items-center gap-2.5 text-[11px] tabular-nums">
                  {speed && (
                    <span className="inline-flex items-center gap-1">
                      <IconGauge size={13} /> {speed}
                    </span>
                  )}
                  {here && (placement.transferring || placement.queuePosition != null) && (
                    <span className="inline-flex items-center gap-1">
                      <IconUsers size={13} />
                      {placement.transferring
                        ? 'downloading now'
                        : `${placement.queuePosition} ahead of you`}
                    </span>
                  )}
                </div>
              </div>
              {eta != null && (
                <Text
                  size="xs"
                  fw={700}
                  c={buy ? 'yellow.6' : undefined}
                  className="whitespace-nowrap tabular-nums"
                >
                  ~{formatDownloadEtaShort(eta)}
                </Text>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex flex-col gap-1 border-t border-gray-3 px-1 pt-2 dark:border-dark-4">
        {!!placement?.boostFee && (
          <Text size="xs" c="dimmed">
            Boosting{placement.totalBytes > 0 ? ` ${formatBytes(placement.totalBytes)}` : ''} costs{' '}
            <Text span inherit fw={600} c="yellow.6">
              <IconBolt size={11} className="inline align-[-1px]" />
              {numberWithCommas(placement.boostFee)}
            </Text>
            .
          </Text>
        )}
        <Text size="xs" c="dimmed">
          Times are best case and move with demand.
        </Text>
      </div>
    </div>
  );
}

export function DownloadLanesInfo({ placement }: { placement?: DownloadLanePlacement }) {
  return (
    <InfoPopover
      size="xs"
      iconProps={{ size: 16 }}
      withinPortal
      width={320}
      zIndex={imageGenerationDrawerZIndex + 1}
    >
      <DownloadLanes placement={placement} />
    </InfoPopover>
  );
}
