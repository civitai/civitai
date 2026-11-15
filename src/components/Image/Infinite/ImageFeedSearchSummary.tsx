import { Alert, Anchor, Button, Pill, Text, Title } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { Tooltip } from '~/components/MantineOverlays';
import type { ImagesQueryParamSchema } from '~/components/Image/image-query-params';
import {
  IMAGE_FEED_SEARCH_UNAVAILABLE_REASON,
  ignoredWhileSearching,
  imageFeedFilterLabels,
} from '~/components/Image/Infinite/image-feed-search';
import useIsClient from '~/hooks/useIsClient';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';

const isEmptyFilter = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.length === 0);

type Props = {
  query: string;
  correctedQuery?: string;
  filters: Parameters<typeof ignoredWhileSearching>[0];
  failed: boolean;
  onRetry: () => void;
};

export function ImageFeedSearchSummary({ query, correctedQuery, filters, failed, onRetry }: Props) {
  const router = useRouter();
  // The saved feed filters load in the browser, so the server can't render their chips.
  const isClient = useIsClient();
  const setStoreFilters = useFiltersContext((state) => state.setImageFilters);
  const storeFilters = useFiltersContext((state) => state.images) as
    | Record<string, unknown>
    | undefined;

  // A filter set by the URL is changed there, one from the saved feed filters in the store. Emptying
  // a URL filter would uncover the saved one under it, so that is cleared too.
  const update = (patch: Partial<ImagesQueryParamSchema>) => {
    const inUrl = Object.keys(patch).filter((key) => key in router.query || key === 'query');
    const uncovered = inUrl.filter(
      (key) =>
        isEmptyFilter(patch[key as keyof typeof patch]) && !isEmptyFilter(storeFilters?.[key])
    );
    // A change of query is a search, so Back returns to the previous one; a filter tweak is not.
    const method = 'query' in patch ? 'push' : 'replace';
    if (inUrl.length)
      void router[method](
        {
          pathname: router.pathname,
          query: removeEmpty({
            ...router.query,
            ...Object.fromEntries(inUrl.map((key) => [key, patch[key as keyof typeof patch]])),
          }),
        },
        undefined,
        { shallow: true }
      );
    const inStore = Object.fromEntries(
      Object.entries(patch).filter(([key]) => !inUrl.includes(key) || uncovered.includes(key))
    );
    if (Object.keys(inStore).length) setStoreFilters(inStore);
  };

  const ignored = ignoredWhileSearching(filters);
  const shownQuery = correctedQuery && correctedQuery !== query ? correctedQuery : undefined;

  return (
    <div className="flex flex-col gap-2 pb-2">
      <Title order={2} size="h3">
        Images matching &ldquo;{query}&rdquo;
      </Title>
      {shownQuery && (
        <Text size="sm" c="dimmed">
          Showing results for <strong>{shownQuery}</strong>
        </Text>
      )}
      {failed && (
        <Alert color="yellow" icon={<IconCloudOff size={18} />} p="xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text size="sm">
              Search isn&rsquo;t answering right now, so this is the feed without your search.
            </Text>
            <Button size="compact-sm" variant="light" onClick={onRetry}>
              Retry search
            </Button>
          </div>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Pill withRemoveButton onRemove={() => update({ query: undefined })}>
          &ldquo;{query}&rdquo;
        </Pill>
        {isClient && filters.period && filters.period !== MetricTimeframe.AllTime && (
          <Pill withRemoveButton onRemove={() => update({ period: MetricTimeframe.AllTime })}>
            Posted: past {filters.period.toLowerCase()}
          </Pill>
        )}
        {isClient &&
          filters.baseModels?.map((baseModel) => (
            <Pill
              key={baseModel}
              withRemoveButton
              onRemove={() =>
                update({ baseModels: filters.baseModels?.filter((x) => x !== baseModel) })
              }
            >
              {baseModel}
            </Pill>
          ))}
        {isClient && filters.username && (
          <Pill withRemoveButton onRemove={() => update({ username: undefined })}>
            @{filters.username}
          </Pill>
        )}
        {isClient && filters.fromPlatform && (
          <Pill withRemoveButton onRemove={() => update({ fromPlatform: undefined })}>
            Made On-site
          </Pill>
        )}
        {isClient && filters.withMeta && (
          <Pill withRemoveButton onRemove={() => update({ withMeta: undefined })}>
            Metadata only
          </Pill>
        )}
        <Anchor component="button" size="sm" onClick={() => update({ query: undefined })}>
          Clear search
        </Anchor>
      </div>
      {isClient && !failed && ignored.length > 0 && (
        <Tooltip label={IMAGE_FEED_SEARCH_UNAVAILABLE_REASON} multiline w={280} withArrow>
          <Text size="xs" c="dimmed" className="w-fit">
            Not applied while searching:{' '}
            {ignored.map((key) => imageFeedFilterLabels[key]).join(', ')}
          </Text>
        </Tooltip>
      )}
    </div>
  );
}
