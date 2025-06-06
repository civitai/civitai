import { Button, Center, Loader, LoadingOverlay } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import { useEffect } from 'react';

import { useToolFilters, useQueryTools } from '~/components/Tool/tools.utils';
import { EndOfFeed } from '~/components/EndOfFeed/EndOfFeed';
import { NoContent } from '~/components/NoContent/NoContent';
import type { GetAllToolsSchema } from '~/server/schema/tool.schema';
import { removeEmpty } from '~/utils/object-helpers';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { MasonryGrid } from '~/components/MasonryColumns/MasonryGrid';
import Link from 'next/link';
import { ToolCard } from '~/components/Cards/ToolCard';

export function ToolsInfinite({
  filters: filterOverrides = {},
  showEof = false,
  showEmptyCta,
}: Props) {
  const toolsFilters = useToolFilters();

  const filters = removeEmpty({ limit: 50, ...toolsFilters, ...filterOverrides });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { tools, loading, fetchNextPage, hasNextPage, refetching } = useQueryTools({
    filters: debouncedFilters,
  });

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <>
      {loading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!tools.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={refetching ?? false} zIndex={9} />
          <MasonryGrid data={tools} render={ToolCard} itemId={(x) => x.id} empty={<NoContent />} />
          {hasNextPage && (
            <InViewLoader
              loadFn={fetchNextPage}
              loadCondition={!refetching}
              style={{ gridColumn: '1/-1' }}
            >
              <Center p="xl" style={{ height: 36 }} mt="md">
                <Loader />
              </Center>
            </InViewLoader>
          )}
          {!hasNextPage && showEof && <EndOfFeed />}
        </div>
      ) : (
        <NoContent py="lg">
          {showEmptyCta && (
            <Link href="/tools/create">
              <Button radius="xl">Write an Article</Button>
            </Link>
          )}
        </NoContent>
      )}
    </>
  );
}

type Props = {
  filters?: Partial<GetAllToolsSchema>;
  showEof?: boolean;
  showEmptyCta?: boolean;
};
