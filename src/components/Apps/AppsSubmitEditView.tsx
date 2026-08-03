import { Alert, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { APPS_PAGE_WIDTHS } from '~/components/Apps/appsPageWidths';
import { ExternalSubmitForm } from '~/components/Apps/ExternalSubmitForm';
import type { ListingEditContext } from '~/components/Apps/offsiteEditConfig';
import { Meta } from '~/components/Meta/Meta';
import { trpc } from '~/utils/trpc';

/**
 * Upper bound (ms) on how long the edit view will sit on its loading spinner
 * before it falls through to the recoverable not-found alert. A healthy
 * `getMyListingForEdit` resolves in well under a second, so on the happy path
 * this ceiling is never reached — it exists purely so the page can NEVER trap
 * the user on an infinite spinner if the query somehow fails to settle (see the
 * `loaderExpired` note below).
 */
export const EDIT_LOADER_CEILING_MS = 15_000;

/**
 * `/apps/submit?edit=<listingId>` body (W13). Fetches the owner's listing via the
 * owner-gated `appListings.getMyListingForEdit` then renders the External wizard in
 * EDIT mode. Handles loading + not-found / not-owner (the proc throws NOT_FOUND /
 * FORBIDDEN → mapped to a friendly inline alert) — the client can't distinguish
 * "missing" from "not yours" (both surface as an error), which is the intended
 * non-enumerable posture. Extracted from the page so it's client-safe + testable
 * without the page's server-side-props graph.
 *
 * 🔴 The loader is BOUNDED and every non-success outcome is terminal. The edit
 * page was reported wedging on "Loading your listing…" forever in production —
 * rendering neither the wizard nor the error alert. Regardless of what leaves the
 * query in a perpetual `isLoading` state, the UI must degrade to a RECOVERABLE
 * state, never an infinite spinner: any settled outcome (thrown error, a settled
 * query with no data, or the loader ceiling elapsing) renders the "Can't edit this
 * listing" alert with a retry, so the user is never stuck. The spinner shows ONLY
 * while a first load is genuinely in flight AND under the ceiling. The alert's
 * "Try again" gives its own in-flight feedback (a disabled "Retrying…" state keyed
 * off `isFetching`) so a retry after an error never looks inert.
 */
export function AppsSubmitEditView({
  listingId,
  loaderCeilingMs = EDIT_LOADER_CEILING_MS,
}: {
  listingId: string;
  /** Overridable loader ceiling (ms) — production uses the default; tests pass a tiny value. */
  loaderCeilingMs?: number;
}) {
  const editQuery = trpc.appListings.getMyListingForEdit.useQuery(
    { listingId },
    { retry: false, refetchOnWindowFocus: false }
  );

  // Bound the spinner. `editQuery.isLoading` is the ONLY thing that can trap the
  // user here — a settled query (success OR error) already resolves to the wizard
  // or the alert below. If the query never settles (the reported prod symptom),
  // `isLoading` stays true forever; this timer lets the UI fall through to the
  // recoverable alert once the ceiling elapses instead of spinning indefinitely.
  // The `retryNonce` is a dep so a manual retry re-arms a fresh ceiling even when
  // `isLoading` never toggled (a stuck query stays `isLoading` across a refetch).
  const [loaderExpired, setLoaderExpired] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  useEffect(() => {
    if (!editQuery.isLoading) {
      setLoaderExpired(false);
      return;
    }
    const id = setTimeout(() => setLoaderExpired(true), loaderCeilingMs);
    return () => clearTimeout(id);
  }, [editQuery.isLoading, loaderCeilingMs, retryNonce]);

  const showLoader = editQuery.isLoading && !loaderExpired;

  // Progress feedback for the alert's "Try again". After a React-Query *error*,
  // a `refetch()` leaves `status: 'error'` (so `isLoading` stays false) and only
  // flips `fetchStatus` to `'fetching'` — `isFetching` is the signal that catches
  // an in-flight retry, `isLoading` does NOT. We AND out `isLoading` so this only
  // covers a background refetch (the settled-error retry), never the initial /
  // never-settled first load — that path is owned by `showLoader` above and its
  // button must stay clickable so a stuck query can still re-arm the ceiling.
  const retryPending = editQuery.isFetching && !editQuery.isLoading;

  const handleRetry = () => {
    setLoaderExpired(false);
    setRetryNonce((n) => n + 1);
    void editQuery.refetch();
  };

  return (
    <>
      <Meta title="Edit an app — Civitai" deIndex />
      <AppsPageLayout
        size={APPS_PAGE_WIDTHS['/apps/submit']}
        title="Edit your app"
        subtitle="Update your external-link app's link, details, or assets."
      >
        {showLoader ? (
          <Group gap={8} data-testid="apps-offsite-edit-loading">
            <Loader size={16} />
            <Text size="sm" c="dimmed">
              Loading your listing…
            </Text>
          </Group>
        ) : editQuery.data ? (
          <ExternalSubmitForm edit={editQuery.data as ListingEditContext} />
        ) : (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertTriangle size={16} />}
            title="Can't edit this listing"
            data-testid="apps-offsite-edit-not-found"
          >
            <Stack gap="xs" align="flex-start">
              <Text size="sm">
                {editQuery.error?.message ??
                  "This listing doesn't exist or you don't have permission to edit it."}
              </Text>
              <Button
                size="xs"
                variant="light"
                color="red"
                data-testid="apps-offsite-edit-retry"
                loading={retryPending}
                disabled={retryPending}
                onClick={handleRetry}
              >
                {retryPending ? 'Retrying…' : 'Try again'}
              </Button>
            </Stack>
          </Alert>
        )}
      </AppsPageLayout>
    </>
  );
}
