import { Badge, Group, Text, Tooltip } from '@mantine/core';
import clsx from 'clsx';
import { chunk } from 'lodash-es';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ResourceLoadAvailability } from '~/server/schema/resource-load.schema';
import { isQueuedAvailability, RESIDENCY_MAX_IDS } from '~/server/schema/resource-load.schema';
import { formatDownloadEta } from '~/components/ResourceLoad/download-eta';
import { settledEtaSeconds } from '~/shared/orchestrator/download-preparation';
import { trpc } from '~/utils/trpc';
import type { GeneratorReadiness } from '~/shared/generation/generator-readiness';

/** The answer is server-cached for 30s (`RESIDENCY_CACHE_SECONDS`), so a faster poll re-reads it. */
const RESIDENCY_POLL_MS = 60_000;

const pollWhileAnyIsCold = (query: {
  state: { data?: { availability: ResourceLoadAvailability }[] };
}) =>
  query.state.data?.every(
    (x) => x.availability.status === 'available' || x.availability.status === 'external'
  )
    ? false
    : RESIDENCY_POLL_MS;

export function useResourceResidency(modelVersionId: number | undefined) {
  const currentUser = useCurrentUser();
  const { data } = trpc.resourceLoad.getResidency.useQuery(
    { modelVersionIds: [modelVersionId ?? 0] },
    {
      enabled: !!currentUser && modelVersionId != null && modelVersionId > 0,
      staleTime: 30_000,
      refetchInterval: pollWhileAnyIsCold,
    }
  );
  return data?.find((x) => x.modelVersionId === modelVersionId)?.availability;
}

type Residency = { loaded: boolean; label: string; color: string; description: string };

const WAIT_NOTE =
  'You can still generate with it — the job waits in your queue until the download finishes, and you can boost it from there.';

export function describeResidency(availability: ResourceLoadAvailability): Residency | null {
  const eta = (source: { progress?: number | null; etaSeconds?: number | null }) => {
    const seconds = settledEtaSeconds(source);
    return seconds != null ? ` Ready in ${formatDownloadEta(seconds)}.` : '';
  };

  switch (availability.status) {
    case 'external':
      return {
        loaded: true,
        label: 'No download needed',
        color: 'green',
        description:
          'Runs through an external provider, so there is nothing to load — generations start right away.',
      };
    case 'available':
      return {
        loaded: true,
        label: 'Loaded',
        color: 'green',
        description: 'Loaded in the generator — generations start right away.',
      };
    case 'loading': {
      const pct = Math.round(availability.progress * 100);
      return {
        loaded: false,
        label: `Downloading ${pct}%`,
        color: 'blue',
        description: `Downloading into the generator.${eta(availability)} ${WAIT_NOTE}`,
      };
    }
    case 'queued':
      return {
        loaded: false,
        label: 'Queued to download',
        color: 'yellow',
        description: `Waiting to download into the generator.${eta(availability)} ${WAIT_NOTE}`,
      };
    case 'unavailable':
      return isQueuedAvailability(availability)
        ? {
            loaded: false,
            label: 'Queued to download',
            color: 'yellow',
            description: `Waiting to download into the generator. ${WAIT_NOTE}`,
          }
        : {
            loaded: false,
            label: 'Not loaded',
            color: 'yellow',
            description: `Not loaded in the generator yet, so generating with it downloads it first, which can take a while. ${WAIT_NOTE}`,
          };
    default:
      return null;
  }
}

const ResidencyBatchContext = createContext<Map<number, ResourceLoadAvailability> | null>(null);

/**
 * One request for the whole list instead of one per row: tRPC request batching is off for most
 * users, so a row each is an HTTP request each.
 */
export function ResidencyBatchProvider({
  modelVersionIds,
  children,
}: {
  modelVersionIds: number[];
  children: ReactNode;
}) {
  const currentUser = useCurrentUser();
  const ids = useMemo(
    () => [...new Set(modelVersionIds.filter((id) => id > 0))].sort((a, b) => a - b),
    [modelVersionIds]
  );
  const batches = useMemo(() => chunk(ids, RESIDENCY_MAX_IDS), [ids]);

  const results = trpc.useQueries((t) =>
    batches.map((modelVersionIds) =>
      t.resourceLoad.getResidency(
        { modelVersionIds },
        {
          enabled: !!currentUser && modelVersionIds.length > 0,
          staleTime: 30_000,
          refetchInterval: pollWhileAnyIsCold,
        }
      )
    )
  );

  const value = useMemo(() => {
    const map = new Map<number, ResourceLoadAvailability>();
    for (const result of results)
      for (const item of result.data ?? []) map.set(item.modelVersionId, item.availability);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results.map((x) => x.dataUpdatedAt).join(',')]);

  return <ResidencyBatchContext.Provider value={value}>{children}</ResidencyBatchContext.Provider>;
}

/** Under a `ResidencyBatchProvider` this reads the batch and never fetches, so an id the provider was not given returns null. */
export function useResidency(modelVersionId: number | undefined) {
  const batched = useContext(ResidencyBatchContext);
  const fetched = useResourceResidency(batched ? undefined : modelVersionId);
  const availability = batched
    ? modelVersionId
      ? batched.get(modelVersionId)
      : undefined
    : fetched;
  return availability ? describeResidency(availability) : null;
}

/** Hollow rather than a second colour, so the state reads without relying on colour. */
function StatusDot({ color, filled }: { color: string; filled: boolean }) {
  const fill = `var(--mantine-color-${color}-5)`;
  return (
    <span
      style={{
        width: 8,
        height: 8,
        flex: '0 0 8px',
        boxSizing: 'border-box',
        borderRadius: '50%',
        background: filled ? fill : 'transparent',
        border: filled ? undefined : `1.5px solid ${fill}`,
        boxShadow: filled ? `0 0 0 2px color-mix(in srgb, ${fill} 25%, transparent)` : undefined,
      }}
    />
  );
}

const LOADED = describeResidency({ status: 'available', workers: 1 }) as Residency;

/** No live read — the caller supplies what it knows. */
export function LoadedMark({ readiness }: { readiness: ResidencyReadiness }) {
  const residency = RESIDENCY_BY_READINESS[readiness];
  return (
    <Tooltip label={residency.description} withArrow multiline w={240}>
      <span role="img" aria-label={residency.label} className="inline-flex shrink-0">
        <StatusDot color={residency.color} filled={residency.loaded} />
      </span>
    </Tooltip>
  );
}

const NOT_LOADED = describeResidency({ status: 'unavailable' }) as Residency;
const EXTERNAL = describeResidency({ status: 'external' }) as Residency;

/** Ready, without saying which kind — all the indexed field knows, since it carries readiness. */
const READY: Residency = {
  loaded: true,
  label: 'Ready',
  color: 'green',
  description: 'Ready in the generator — generations start right away.',
};

/** The indexed field cannot tell a resident model from an external one; the DB fields can. */
export type ResidencyReadiness = GeneratorReadiness | 'ready';

const RESIDENCY_BY_READINESS: Record<ResidencyReadiness, Residency> = {
  loaded: LOADED,
  external: EXTERNAL,
  cold: NOT_LOADED,
  ready: READY,
};

/**
 * Top-left because `GenerateButton` owns the right corner for its price badge. Shows no download
 * progress: a download already running still means Create will not start now, and the version
 * details row names that state.
 */
export function LoadedCornerBadge({ readiness }: { readiness: GeneratorReadiness }) {
  const residency = RESIDENCY_BY_READINESS[readiness];
  return (
    <Tooltip label={residency.description} withArrow multiline w={240}>
      <Badge
        className="absolute -left-2 -top-2 z-10 cursor-default border border-solid border-gray-3 bg-gray-1 pl-1.5 pr-2 dark:border-dark-4 dark:bg-dark-5"
        size="sm"
        radius="xl"
        leftSection={<StatusDot color={residency.color} filled={residency.loaded} />}
      >
        <Text size="10px" fw={600} c={`${residency.color}.5`} tt="none">
          {residency.label}
        </Text>
      </Badge>
    </Tooltip>
  );
}

/** Names the cold state explicitly: a blank reads as missing data, not as "not loaded". */
export function ResourceResidencyStatus({
  modelVersionId,
  className,
  tooltipWidth = 260,
  readiness,
}: {
  modelVersionId: number;
  className?: string;
  tooltipWidth?: number;
  /**
   * What the page's own data already says (`generatorReadiness`). The live read answers a request
   * later, so without this the row renders empty and then pops in — and for a signed-out viewer,
   * never.
   */
  readiness?: ResidencyReadiness;
}) {
  const live = useResidency(modelVersionId);
  const residency = live ?? (readiness === undefined ? null : RESIDENCY_BY_READINESS[readiness]);
  if (!residency) return null;

  return (
    <Tooltip multiline w={tooltipWidth} withArrow label={residency.description}>
      <Group gap={6} wrap="nowrap" className={clsx('cursor-default', className)}>
        <StatusDot color={residency.color} filled={residency.loaded} />
        <Text size="xs" c={`${residency.color}.5`}>
          {residency.label}
        </Text>
      </Group>
    </Tooltip>
  );
}
