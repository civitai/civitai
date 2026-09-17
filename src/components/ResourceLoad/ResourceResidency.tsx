import { HoverCard, Text, ThemeIcon } from '@mantine/core';
import { IconCloudDownload } from '@tabler/icons-react';
import { chunk } from 'lodash-es';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ResourceLoadAvailability } from '~/server/schema/resource-load.schema';
import { isQueuedAvailability } from '~/server/schema/resource-load.schema';
import { formatDownloadEta } from '~/components/ResourceLoad/download-eta';
import { trpc } from '~/utils/trpc';

export function useResourceResidency(modelVersionId: number | undefined) {
  const currentUser = useCurrentUser();
  const { data } = trpc.resourceLoad.getResidency.useQuery(
    { modelVersionIds: [modelVersionId ?? 0] },
    { enabled: !!currentUser && !!modelVersionId, staleTime: 30_000 }
  );
  return data?.find((x) => x.modelVersionId === modelVersionId)?.availability;
}

type Residency = { loaded: boolean; label: string; color: string; description: string };

const WAIT_NOTE =
  'You can still generate with it — the job waits in your queue until the download finishes, and you can boost it from there.';

export function describeResidency(availability: ResourceLoadAvailability): Residency | null {
  const eta = (seconds: number | null | undefined) =>
    seconds != null ? ` Ready in ${formatDownloadEta(seconds)}.` : '';

  switch (availability.status) {
    case 'available':
      return {
        loaded: true,
        label: 'Loaded',
        color: 'green',
        description: 'Loaded on the generator — generations start right away.',
      };
    case 'loading': {
      const pct = Math.round(availability.progress * 100);
      return {
        loaded: false,
        label: `Downloading ${pct}%`,
        color: 'blue',
        description: `Downloading to the generator.${eta(availability.etaSeconds)} ${WAIT_NOTE}`,
      };
    }
    case 'queued':
      return {
        loaded: false,
        label: 'Queued to download',
        color: 'yellow',
        description: `Waiting to download to the generator.${eta(
          availability.etaSeconds
        )} ${WAIT_NOTE}`,
      };
    case 'unavailable':
      return isQueuedAvailability(availability)
        ? {
            loaded: false,
            label: 'Queued to download',
            color: 'yellow',
            description: `Waiting to download to the generator. ${WAIT_NOTE}`,
          }
        : {
            loaded: false,
            label: 'Not loaded',
            color: 'yellow',
            description: `Not on the generator yet, so generating with it downloads it first, which can take a while. ${WAIT_NOTE}`,
          };
    default:
      return null;
  }
}

export function useResidencyDescription(modelVersionId: number | undefined) {
  const availability = useResourceResidency(modelVersionId);
  return availability ? describeResidency(availability) : null;
}

const ResidencyBatchContext = createContext<Map<number, ResourceLoadAvailability> | null>(null);

/** One page of picker results. The endpoint takes a page at a time; more than that is paging. */
const RESIDENCY_BATCH_SIZE = 50;

/**
 * Loads one page of results' load state in a single request. Without it every card asks on its own,
 * and request batching is off for most users, so a page of results is a page of HTTP requests.
 */
export function ResidencyBatchProvider({
  modelVersionIds,
  children,
}: {
  modelVersionIds: number[];
  children: ReactNode;
}) {
  const currentUser = useCurrentUser();
  const ids = useMemo(() => [...new Set(modelVersionIds)].sort((a, b) => a - b), [modelVersionIds]);
  const batches = useMemo(() => chunk(ids, RESIDENCY_BATCH_SIZE), [ids]);

  const results = trpc.useQueries((t) =>
    batches.map((modelVersionIds) =>
      t.resourceLoad.getResidency(
        { modelVersionIds },
        { enabled: !!currentUser && modelVersionIds.length > 0, staleTime: 30_000 }
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

/** Nothing to show for a loaded resource — a compact row needs no mark. */
export function ResourceResidencyIcon({ modelVersionId }: { modelVersionId: number }) {
  const batched = useContext(ResidencyBatchContext);
  const fetched = useResourceResidency(batched ? undefined : modelVersionId);
  const availability = batched ? batched.get(modelVersionId) : fetched;
  const residency = availability ? describeResidency(availability) : null;
  if (!residency || residency.loaded) return null;

  return (
    <HoverCard position="bottom" withArrow width={240}>
      <HoverCard.Target>
        <ThemeIcon size={18} color={residency.color} variant="filled" className="shrink-0">
          <IconCloudDownload size={14} />
        </ThemeIcon>
      </HoverCard.Target>
      <HoverCard.Dropdown>
        <Text size="sm" fw={500}>
          {residency.label}
        </Text>
        <Text size="xs">{residency.description}</Text>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}
