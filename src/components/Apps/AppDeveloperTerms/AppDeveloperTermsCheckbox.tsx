import { Anchor, Checkbox, Text } from '@mantine/core';
import Link from 'next/link';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import {
  APP_DEVELOPER_TERMS_PATH,
  APP_DEVELOPER_TERMS_VERSION,
} from '~/shared/constants/app-developer-terms.constants';

/** True once the signed-in developer has accepted the current App Developer Terms version. */
export function useAppDeveloperTermsAccepted() {
  const { data } = trpc.appListings.getDeveloperTermsStatus.useQuery();
  return !!data?.acceptedAt;
}

/**
 * Ticking the box records the acceptance. Every publish path refuses server-side until it is
 * recorded, so a submit button beside this stays disabled until `useAppDeveloperTermsAccepted`.
 */
export function AppDeveloperTermsCheckbox() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.appListings.getDeveloperTermsStatus.useQuery();
  const accept = trpc.appListings.acceptDeveloperTerms.useMutation({
    onSuccess: (status) => utils.appListings.getDeveloperTermsStatus.setData(undefined, status),
    onError: (error) => showErrorNotification({ title: 'Could not record your acceptance', error }),
  });
  const accepted = !!data?.acceptedAt;

  return (
    <Checkbox
      data-testid="app-developer-terms-checkbox"
      checked={accepted || accept.isPending}
      disabled={accepted || isLoading || accept.isPending}
      onChange={(e) => {
        if (e.currentTarget.checked) accept.mutate({ version: APP_DEVELOPER_TERMS_VERSION });
      }}
      label={
        <Text size="sm" component="span">
          I accept the{' '}
          <Anchor component={Link} href={APP_DEVELOPER_TERMS_PATH} target="_blank">
            App Developer Terms
          </Anchor>
        </Text>
      }
      description={accepted ? 'Accepted. You will be asked again if the terms change.' : undefined}
    />
  );
}
