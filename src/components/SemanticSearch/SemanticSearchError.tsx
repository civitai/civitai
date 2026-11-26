import type { ReactElement } from 'react';
import { Alert, Center, Loader } from '@mantine/core';
import { NoContent } from '~/components/NoContent/NoContent';
import { SearchRefusalNotice } from '~/components/Search/SearchRefusalNotice';
import { isSearchRefusedError, type SearchRefusal } from '~/components/Search/search-refusal';
import type { SearchRefusedBy } from '~/shared/constants/search-refusal.constants';

type SearchError = { message: string; data?: { code?: string } | null } | null;

/**
 * A failed semantic search. A refused one (422 `search_refused`) is no outage: it shows the policy
 * message. Anything else keeps the error's own text, or the outage line.
 */
export function SemanticSearchError({ error }: { error: SearchError }) {
  if (isSearchRefusedError(error)) return <SearchRefusalNotice refusal="profanity" />;
  return (
    <Alert color="red" title="Search failed">
      {error?.data?.code === 'NOT_FOUND' || error?.data?.code === 'TOO_MANY_REQUESTS'
        ? error.message
        : 'Search is unavailable right now, try again.'}
    </Alert>
  );
}

/**
 * What the semantic search page shows in place of results, or null to show them. The browser's own
 * refusal comes first: that text is never searched, so it shows the same notices the feeds do.
 * A plain function (no hooks), so the page can tell "nothing to show" from a status.
 */
export function semanticSearchStatus({
  refusal,
  serverRefusal,
  enabled,
  isLoading,
  error,
  empty,
  idleMessage,
  emptyMessage,
}: {
  refusal?: SearchRefusal;
  serverRefusal?: { refusedBy?: SearchRefusedBy };
  enabled: boolean;
  isLoading: boolean;
  error: SearchError;
  empty: boolean;
  idleMessage: string;
  emptyMessage: string;
}): ReactElement | null {
  if (refusal) return <SearchRefusalNotice refusal={refusal} />;
  if (!enabled) return <NoContent message={idleMessage} />;
  if (isLoading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );
  if (error) return <SemanticSearchError error={error} />;
  if (empty && serverRefusal)
    return <SearchRefusalNotice refusal="policy" refusedBy={serverRefusal.refusedBy} />;
  if (empty) return <NoContent message={emptyMessage} />;
  return null;
}
