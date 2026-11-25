import { Alert } from '@mantine/core';
import { SearchRefusalNotice } from '~/components/Search/SearchRefusalNotice';
import { isSearchRefusedError } from '~/components/Search/search-refusal';
/**
 * A failed semantic search. A refused one (422 `search_refused`) is no outage: it shows the policy
 * message. Anything else keeps the error's own text, or the outage line.
 */
export function SemanticSearchError({
  error,
}: {
  error: { message: string; data?: { code?: string } | null } | null;
}) {
  if (isSearchRefusedError(error)) return <SearchRefusalNotice refusal="profanity" />;
  return (
    <Alert color="red" title="Search failed">
      {error?.data?.code === 'NOT_FOUND' || error?.data?.code === 'TOO_MANY_REQUESTS'
        ? error.message
        : 'Search is unavailable right now, try again.'}
    </Alert>
  );
}
