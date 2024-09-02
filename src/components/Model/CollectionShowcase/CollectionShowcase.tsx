import { Loader, LoadingOverlay, ScrollArea } from '@mantine/core';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useQueryModelCollectionShowcase } from '~/components/Model/model.utils';

export function CollectionShowcase({ modelId }: Props) {
  const {
    items = [],
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetching,
    isRefetching,
  } = useQueryModelCollectionShowcase({ modelId });

  return (
    <ScrollArea.Autosize maxHeight={300}>
      {isLoading ? (
        <div className="flex items-center justify-center p-2">
          <Loader variant="bars" size="sm" />
        </div>
      ) : (
        <div className="relative">
          <LoadingOverlay visible={isRefetching} zIndex={9} />
          {items.map((model) => (
            <div key={model.id} className="px-3 py-2">
              {model.name}
            </div>
          ))}
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!isFetching}
              style={{ gridColumn: '1/-1' }}
            >
              <div className="flex items-center justify-center px-4 py-2">
                <Loader variant="bars" size="sm" />
              </div>
            </InViewLoader>
          )}
        </div>
      )}
    </ScrollArea.Autosize>
  );
}

type Props = { modelId: number };
