import { Loader, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useMemo } from 'react';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import {
  LOOKUP_NOT_FOUND,
  resolveLookupHit,
  type ResourceLookup,
} from '~/components/ImageGeneration/GenerationForm/resource-lookup';
import { queryRetry, trpc } from '~/utils/trpc';
import { ResourceSelectCard } from './ResourceSelectCard';

export function ResourceLookupResult({ lookup }: { lookup: ResourceLookup }) {
  const { selectSource, canGenerate, resources, filters, excludedIds, excludeTurbo } =
    useResourceSelectContext();

  const { data, isLoading, isError } = trpc.model.getResourceSelect.useQuery(
    { tab: 'all', selectSource, canGenerate, limit: 1, lookup },
    {
      trpc: { abortOnUnmount: true, context: { skipBatch: true } },
      // A 503 is the server's Meili timeout; a retry queues a second search behind the first.
      retry: (failureCount, error) =>
        error.data?.code !== 'SERVICE_UNAVAILABLE' && queryRetry(failureCount, error),
    }
  );

  const { items, loadingPreferences, hiddenCount } = useApplyHiddenPreferences({
    type: 'models',
    data: data?.items,
  });

  const model = items[0];
  const resolved = useMemo(
    () =>
      model
        ? resolveLookupHit(model, {
            modelVersionId: lookup.modelVersionId,
            resources,
            filters,
            excludedIds,
            canGenerate,
            coverageNext: data?.coverageNext,
            member: data?.member,
            excludeTurbo,
          })
        : null,
    [model, lookup, resources, filters, excludedIds, canGenerate, data, excludeTurbo]
  );

  if (isLoading || loadingPreferences)
    return (
      <div className="flex justify-center p-3">
        <Loader size="sm" />
      </div>
    );

  const note = isError
    ? 'Couldn’t look up that link. Try again in a moment.'
    : !model
    ? hiddenCount > 0
      ? 'This model has been hidden due to your settings.'
      : LOOKUP_NOT_FOUND
    : resolved?.note;

  return (
    <div className="flex flex-col gap-3 p-3 pb-0">
      {note && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-md border border-gray-3 bg-gray-0 p-2.5 dark:border-dark-4 dark:bg-dark-6"
        >
          <IconInfoCircle size={16} className="mt-0.5 shrink-0 text-gray-6 dark:text-dark-2" />
          <Text size="sm">{note}</Text>
        </div>
      )}
      {model && !!resolved?.versions.length && (
        <div className="w-full max-w-[350px]">
          <ResourceSelectCard
            data={{ ...model, versions: resolved.versions }}
            selectSource={selectSource}
            coverageNext={data?.coverageNext}
          />
        </div>
      )}
    </div>
  );
}
