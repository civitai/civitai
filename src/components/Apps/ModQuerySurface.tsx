import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ReactNode } from 'react';

/**
 * Shared error handling for the DARK, mod-only App Blocks review surfaces
 * (AppListingsModerationTable, OffsiteReviewQueue, OffsiteReportsQueue, the review
 * page's active-previews panel). Every one gates its query on
 * `enabled: !!features?.appBlocks` + `retry: false` and used to do a blanket
 * `if (query.error) return null` — which correctly hides the surface for a non-mod
 * (moderatorProcedure → UNAUTHORIZED/FORBIDDEN) but ALSO silently blanked the whole
 * surface on a transient 500 / network blip, with no way to recover.
 *
 * {@link isModAuthzError} isolates the intended "render nothing" case (authz), so a
 * caller can keep returning null for it while rendering {@link ModQueryError} (an
 * Alert + a Retry that refetches) for everything else.
 */

/** A tRPC client error carries the server error code at `data.code`. */
type MaybeTrpcError = { message?: string; data?: { code?: string } | null } | null | undefined;

/** True for the AUTHZ codes a non-mod / unauthenticated caller hits — the ONLY case
 *  a dark mod surface should silently render nothing for. */
export function isModAuthzError(error: MaybeTrpcError): boolean {
  const code = error?.data?.code;
  return code === 'UNAUTHORIZED' || code === 'FORBIDDEN';
}

export function ModQueryError({
  error,
  onRetry,
  isRetrying,
  title = 'Couldn’t load',
  testId,
  mt = 'lg',
}: {
  error: MaybeTrpcError;
  onRetry: () => void;
  isRetrying?: boolean;
  title?: ReactNode;
  testId?: string;
  mt?: string;
}) {
  return (
    <Alert
      color="red"
      variant="light"
      icon={<IconAlertTriangle size={16} />}
      title={title}
      mt={mt}
      data-testid={testId}
    >
      <Stack gap="xs">
        <Text size="sm">{error?.message ?? 'Something went wrong.'}</Text>
        <Group>
          <Button
            size="xs"
            variant="default"
            onClick={onRetry}
            loading={isRetrying}
            data-testid={testId ? `${testId}-retry` : undefined}
          >
            Retry
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}
