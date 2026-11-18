import { Alert, Anchor, Button, Text, Title } from '@mantine/core';
import { IconCloudOff } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { removeEmpty } from '~/utils/object-helpers';

type Props = {
  /** What the feed lists, as the title words it: "Models", "Articles". */
  noun: string;
  query: string;
  correctedQuery?: string;
  failed: boolean;
  onRetry: () => void;
};

/** Above a feed while it answers a search: what was searched, and the way back out. */
export function FeedSearchSummary({ noun, query, correctedQuery, failed, onRetry }: Props) {
  const router = useRouter();
  const shownQuery = correctedQuery && correctedQuery !== query ? correctedQuery : undefined;

  return (
    <div className="flex flex-col gap-2 pb-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Title order={2} size="h3">
          {noun} matching &ldquo;{query}&rdquo;
        </Title>
        {/* A change of query is a search, so Back returns to the previous one. */}
        <Anchor
          component="button"
          size="sm"
          onClick={() =>
            void router.push(
              {
                pathname: router.pathname,
                query: removeEmpty({ ...router.query, query: undefined }),
              },
              undefined,
              { shallow: true }
            )
          }
        >
          Clear search
        </Anchor>
      </div>
      {shownQuery && (
        <Text size="sm" c="dimmed">
          Showing results for <strong>{shownQuery}</strong>
        </Text>
      )}
      {failed && (
        <Alert color="yellow" icon={<IconCloudOff size={18} />} p="xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text size="sm">
              Search isn&rsquo;t answering right now, so these are keyword matches instead.
            </Text>
            <Button size="compact-sm" variant="light" onClick={onRetry}>
              Retry search
            </Button>
          </div>
        </Alert>
      )}
    </div>
  );
}
