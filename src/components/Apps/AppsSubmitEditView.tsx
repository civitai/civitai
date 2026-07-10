import { Alert, Group, Loader, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { AppsPageLayout } from '~/components/Apps/AppsPageLayout';
import { ExternalSubmitForm } from '~/components/Apps/ExternalSubmitForm';
import type { ListingEditContext } from '~/components/Apps/offsiteEditConfig';
import { Meta } from '~/components/Meta/Meta';
import { trpc } from '~/utils/trpc';

/**
 * `/apps/submit?edit=<listingId>` body (W13). Fetches the owner's listing via the
 * owner-gated `appListings.getMyListingForEdit` then renders the External wizard in
 * EDIT mode. Handles loading + not-found / not-owner (the proc throws NOT_FOUND /
 * FORBIDDEN → mapped to a friendly inline alert) — the client can't distinguish
 * "missing" from "not yours" (both surface as an error), which is the intended
 * non-enumerable posture. Extracted from the page so it's client-safe + testable
 * without the page's server-side-props graph.
 */
export function AppsSubmitEditView({ listingId }: { listingId: string }) {
  const editQuery = trpc.appListings.getMyListingForEdit.useQuery(
    { listingId },
    { retry: false, refetchOnWindowFocus: false }
  );

  return (
    <>
      <Meta title="Edit an app — Civitai" deIndex />
      <AppsPageLayout
        size="sm"
        title="Edit your app"
        subtitle="Update your external-link app's link, details, or assets."
      >
        {editQuery.isLoading ? (
          <Group gap={8} data-testid="apps-offsite-edit-loading">
            <Loader size={16} />
            <Text size="sm" c="dimmed">
              Loading your listing…
            </Text>
          </Group>
        ) : editQuery.isError || !editQuery.data ? (
          <Alert
            color="red"
            variant="light"
            icon={<IconAlertTriangle size={16} />}
            title="Can't edit this listing"
            data-testid="apps-offsite-edit-not-found"
          >
            <Text size="sm">
              {editQuery.error?.message ??
                "This listing doesn't exist or you don't have permission to edit it."}
            </Text>
          </Alert>
        ) : (
          <ExternalSubmitForm edit={editQuery.data as ListingEditContext} />
        )}
      </AppsPageLayout>
    </>
  );
}
