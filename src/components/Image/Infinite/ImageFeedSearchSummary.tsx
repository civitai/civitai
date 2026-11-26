import { Alert, Anchor, Button, Chip, Pill, Text, Title } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { IconCloudOff } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { NextLink } from '~/components/NextLink/NextLink';
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
import { SEARCH_AS_TYPED_PARAM } from '~/components/Search/useSearchAsTyped';
import { CorrectedQueryNote } from '~/components/Search/FeedSearchSummary';

const isEmptyFilter = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.length === 0);

type Props = {
  query: string;
  /** "More like this": the image matched while no query is set. */
  similarTo?: number;
  /** "More like this" steering, for a viewer who may steer (`MoreLikeThisPrefer`). */
  preferRow?: ReactNode;
  correctedQuery?: string;
  filters: Parameters<typeof ignoredWhileSearching>[0];
  failed: boolean;
  /** "More like this" from an image it can't search: told plainly, not as an outage. */
  unavailable?: boolean;
  onRetry: () => void;
};

export function ImageFeedSearchSummary({
  query,
  similarTo,
  preferRow,
  correctedQuery,
  filters,
  failed,
  unavailable,
  onRetry,
}: Props) {
  const currentUser = useCurrentUser();
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
    const inUrl = Object.keys(patch).filter(
      (key) => key in router.query || key === 'query' || key === 'similarTo'
    );
    const uncovered = inUrl.filter(
      (key) =>
        isEmptyFilter(patch[key as keyof typeof patch]) && !isEmptyFilter(storeFilters?.[key])
    );
    // A new search is a history entry, so Back returns to the previous one; a filter tweak is not.
    const method = 'query' in patch || 'similarTo' in patch ? 'push' : 'replace';
    if (inUrl.length)
      void router[method](
        {
          pathname: router.pathname,
          query: removeEmpty({
            ...router.query,
            ...Object.fromEntries(inUrl.map((key) => [key, patch[key as keyof typeof patch]])),
            // A changed or cleared query is corrected again.
            ...('query' in patch && { [SEARCH_AS_TYPED_PARAM]: undefined }),
            // A preference belongs to its anchor.
            ...(('query' in patch || 'similarTo' in patch) && { prefer: undefined }),
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

  return (
    <div className="flex flex-col gap-2 pb-2">
      <Title order={2} size="h3">
        {similarTo ? (
          <>
            Images like{' '}
            <Anchor component={NextLink} href={`/images/${similarTo}`} inherit>
              this image
            </Anchor>
          </>
        ) : (
          <>Images matching &ldquo;{query}&rdquo;</>
        )}
      </Title>
      <CorrectedQueryNote query={query} correctedQuery={correctedQuery} />
      {unavailable ? (
        <Alert color="gray" p="xs">
          <Text size="sm">
            More like this isn&rsquo;t available for this image, so this is the feed without it.
          </Text>
        </Alert>
      ) : (
        failed && (
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
        )
      )}
      <div className="flex flex-wrap items-center gap-2">
        {similarTo ? (
          <>
            <Pill withRemoveButton onRemove={() => update({ similarTo: undefined })}>
              Similar to this image
            </Pill>
            {currentUser && (
              <Chip
                size="xs"
                checked={router.query.excludeOwn === 'true'}
                onChange={(checked) =>
                  void router.replace(
                    {
                      pathname: router.pathname,
                      query: removeEmpty({
                        ...router.query,
                        excludeOwn: checked ? 'true' : undefined,
                      }),
                    },
                    undefined,
                    { shallow: true }
                  )
                }
              >
                Hide my images
              </Chip>
            )}
          </>
        ) : (
          <Pill withRemoveButton onRemove={() => update({ query: undefined })}>
            &ldquo;{query}&rdquo;
          </Pill>
        )}
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
        <Anchor
          component="button"
          size="sm"
          onClick={() => update({ query: undefined, similarTo: undefined })}
        >
          Clear search
        </Anchor>
      </div>
      {similarTo && !unavailable && preferRow}
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
