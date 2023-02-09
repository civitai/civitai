import { Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { ModelType } from '@prisma/client';
import { IconAlertCircle } from '@tabler/icons';
import React from 'react';

import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { Countdown } from '~/components/Countdown/Countdown';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isFutureDate } from '~/utils/date-helpers';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

export function EarlyAccessAlert({ versionId, modelType, deadline }: Props) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();

  const inEarlyAccess = features.earlyAccessModel && !!deadline && isFutureDate(deadline);

  const { data: { Notify: notifying = [] } = { Notify: [] } } =
    trpc.user.getEngagedModelVersions.useQuery(undefined, {
      enabled: !!currentUser && inEarlyAccess,
      cacheTime: Infinity,
      staleTime: Infinity,
    });
  const alreadyNotifying = notifying.includes(versionId);

  const toggleNotifyMutation = trpc.modelVersion.toggleNotifyEarlyAccess.useMutation({
    async onMutate() {
      await queryUtils.user.getEngagedModels.cancel();

      const prevEngaged = queryUtils.user.getEngagedModelVersions.getData();

      // Toggle the model in the Notify list
      queryUtils.user.getEngagedModelVersions.setData(
        undefined,
        ({ Notify = [], ...old } = { Notify: [] }) => {
          if (alreadyNotifying) return { Notify: Notify.filter((id) => id !== versionId), ...old };
          return { Notify: [...Notify, versionId], ...old };
        }
      );

      return { prevEngaged };
    },
    onSuccess() {
      showSuccessNotification({
        message: alreadyNotifying
          ? 'You have been removed from the notification list'
          : 'You will be notified when this is available for download',
      });
    },
    onError(error, _variables, context) {
      showErrorNotification({ error: new Error(error.message) });
      queryUtils.user.getEngagedModelVersions.setData(undefined, context?.prevEngaged);
    },
  });
  const handleNotifyMeClick = () => {
    toggleNotifyMutation.mutate({ id: versionId });
  };

  if (!inEarlyAccess || currentUser?.isMember) return null;

  return (
    <AlertWithIcon color="green" iconColor="green" icon={<IconAlertCircle />}>
      {`This ${splitUppercase(
        modelType
      ).toLowerCase()} is in "Early Access" to collect feedback from `}{' '}
      <Text variant="link" component={NextLink} href="/pricing">
        Supporter Tier members
      </Text>
      {`. It will be publicly available in `}
      <Countdown endTime={deadline} />
      {'. '}
      <LoginRedirect reason="notify-version">
        <Text
          variant="link"
          onClick={!toggleNotifyMutation.isLoading ? handleNotifyMeClick : undefined}
          sx={{ cursor: toggleNotifyMutation.isLoading ? 'not-allowed' : 'pointer', lineHeight: 1 }}
          span
        >
          {alreadyNotifying
            ? 'Remove me from this notification.'
            : `Notify me when it's available.`}
        </Text>
      </LoginRedirect>
    </AlertWithIcon>
  );
}

type Props = { versionId: number; modelType: ModelType; deadline?: Date };
