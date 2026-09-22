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
import cardClasses from '~/components/Cards/Cards.module.css';

/**
 * Loaded is the state that arrives while someone is looking at it, and nothing pushes it — the
 * queue card invalidates this query for a model it watches land, and this is the backstop for
 * every other way one becomes resident. Never faster than the server's own 30s cache.
 */
const RESIDENCY_POLL_MS = 60_000;

const pollWhileAnyIsCold = (query: {
  state: { data?: { availability: ResourceLoadAvailability }[] };
}) =>
  query.state.data?.every((x) => x.availability.status === 'available') ? false : RESIDENCY_POLL_MS;

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

type LoadedMarkVariant = 'dot' | 'overlay';

const LOADED = describeResidency({ status: 'available', workers: 1 }) as Residency;

/** Renders nothing unless loaded: loaded is the rare state, which is what keeps the mark worth reading. */
export function ResourceLoadedDot({
  modelVersionId,
  variant,
}: {
  modelVersionId: number;
  variant?: LoadedMarkVariant;
}) {
  const residency = useResidency(modelVersionId);
  return residency?.loaded ? <LoadedMark variant={variant} /> : null;
}

/** For callers that already know the version is loaded, e.g. from the search index. */
export function LoadedMark({ variant = 'dot' }: { variant?: LoadedMarkVariant }) {
  const dot = <StatusDot color={LOADED.color} filled />;
  return (
    <Tooltip label={LOADED.description} withArrow multiline w={240}>
      {variant === 'dot' ? (
        <span role="img" aria-label={LOADED.label} className="inline-flex shrink-0">
          {dot}
        </span>
      ) : (
        <Badge
          className={clsx(cardClasses.infoChip, cardClasses.chip, 'cursor-default')}
          variant="light"
          radius="xl"
          leftSection={dot}
        >
          {LOADED.label}
        </Badge>
      )}
    </Tooltip>
  );
}

const NOT_LOADED = describeResidency({ status: 'unavailable' }) as Residency;

/**
 * Top-left because `GenerateButton` owns the right corner for its price badge. Binary on purpose: a
 * download already running still means Create will not start now — the version details row names
 * that state.
 */
export function LoadedCornerBadge({ loaded }: { loaded: boolean }) {
  const residency = loaded ? LOADED : NOT_LOADED;
  return (
    <Tooltip label={residency.description} withArrow multiline w={240}>
      <Badge
        className="absolute -left-2 -top-2 z-10 cursor-default border border-solid border-gray-3 bg-gray-1 pl-1.5 pr-2 dark:border-dark-4 dark:bg-dark-5"
        size="sm"
        radius="xl"
        leftSection={<StatusDot color={residency.color} filled={loaded} />}
      >
        <Text size="10px" fw={600} c={`${residency.color}.5`} tt="none">
          {residency.label}
        </Text>
      </Badge>
    </Tooltip>
  );
}

/**
 * The generator's rows, where a cold resource has to say so: the wait is the thing the user is about
 * to pay for in queue time. Live, so it also names a download already running or queued.
 */
export function ResourceLoadState({ modelVersionId }: { modelVersionId: number }) {
  const residency = useResidency(modelVersionId);
  if (!residency) return null;

  return (
    <Tooltip label={residency.description} withArrow multiline w={240}>
      <Group gap={6} wrap="nowrap" className="w-fit shrink-0 cursor-default">
        <StatusDot color={residency.color} filled={residency.loaded} />
        <Text size="xs" c={`${residency.color}.5`}>
          {residency.label}
        </Text>
      </Group>
    </Tooltip>
  );
}

/** States both outcomes: in a labelled row an empty value reads as missing data, not "not loaded". */
export function ResourceResidencyStatus({ modelVersionId }: { modelVersionId: number }) {
  const residency = useResidency(modelVersionId);
  if (!residency) return null;

  return (
    <Tooltip multiline w={260} withArrow label={residency.description}>
      <Group gap={6} wrap="nowrap" className="cursor-default">
        <StatusDot color={residency.color} filled={residency.loaded} />
        <Text size="xs" c={`${residency.color}.5`}>
          {residency.label}
        </Text>
      </Group>
    </Tooltip>
  );
}
