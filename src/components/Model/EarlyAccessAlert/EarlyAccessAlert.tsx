import { Anchor, Text, Alert, Stack } from '@mantine/core';
import type { ModelType } from '~/shared/utils/prisma/enums';
import React from 'react';

import { Countdown } from '~/components/Countdown/Countdown';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { isFutureDate } from '~/utils/date-helpers';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { useQueryModelVersionDonationGoals } from '../ModelVersions/model-version.utils';
import { constants, EARLY_ACCESS_CONFIG } from '~/server/common/constants';

export function EarlyAccessAlert({ modelId, versionId, modelType, deadline }: Props) {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const { donationGoals } = useQueryModelVersionDonationGoals({
    modelVersionId: versionId,
  });

  const inEarlyAccess = features.earlyAccessModel && !!deadline && isFutureDate(deadline);

  const { data: { Notify: notifying = [] } = { Notify: [] } } =
    trpc.user.getEngagedModelVersions.useQuery(
      { id: modelId },
      {
        enabled: !!currentUser && inEarlyAccess,
        cacheTime: Infinity,
        staleTime: Infinity,
      }
    );
  const alreadyNotifying = notifying.includes(versionId);

  const toggleNotifyMutation = trpc.modelVersion.toggleNotifyEarlyAccess.useMutation({
    async onMutate() {
      await queryUtils.user.getEngagedModels.cancel();

      const prevEngaged = queryUtils.user.getEngagedModelVersions.getData();

      // Toggle the model in the Notify list
      queryUtils.user.getEngagedModelVersions.setData(
        { id: modelId },
        ({ Notify = [], ...old } = { Notify: [], Downloaded: [] }) => {
          if (alreadyNotifying) return { Notify: Notify.filter((id) => id !== versionId), ...old };
          return { Notify: [...Notify, versionId], ...old };
        }
      );

      return { prevEngaged };
    },
    onSuccess() {
      showSuccessNotification({
        message: !alreadyNotifying
          ? 'You have been removed from the notification list'
          : 'You will be notified when this is available for download',
      });
    },
    onError(error, _variables, context) {
      showErrorNotification({ error: new Error(error.message) });
      queryUtils.user.getEngagedModelVersions.setData({ id: modelId }, context?.prevEngaged);
    },
  });

  const handleNotifyMeClick = () => {
    toggleNotifyMutation.mutate({ id: versionId });
  };

  if (!inEarlyAccess) return null;

  const earlyAccessDonationGoal = (donationGoals ?? []).find((dg) => dg.isEarlyAccess);

  return (
    <Alert color="yellow">
      <Stack>
        <Text size="xs">
          The creator of this {getDisplayName(modelType)} has set this version to{' '}
          <Text fw="bold" component="span">
            Early Access
          </Text>{' '}
          and as such it is only available for people who purchase it. This{' '}
          {getDisplayName(modelType)} will be available for free in{' '}
          <Text fw="bold" component="span">
            <Countdown endTime={deadline} />
          </Text>{' '}
          {earlyAccessDonationGoal ? ' or once the donation goal is met' : ''}. If you want to know
          more, check out our article{' '}
          <Anchor
            c="yellow"
            td="underline"
            target="_blank"
            href={`/articles/${EARLY_ACCESS_CONFIG.article}`}
          >
            here
          </Anchor>
          .
        </Text>
        <LoginRedirect reason="notify-version">
          <Text
            variant="link"
            onClick={
              !toggleNotifyMutation.isLoading && features.canWrite ? handleNotifyMeClick : undefined
            }
            style={{
              cursor:
                toggleNotifyMutation.isLoading || !features.canWrite ? 'not-allowed' : 'pointer',
              lineHeight: 1,
            }}
            c="yellow"
            span
          >
            {alreadyNotifying
              ? 'Remove me from this notification.'
              : `Notify me when it's available.`}
          </Text>
        </LoginRedirect>
      </Stack>
    </Alert>
  );
}

type Props = { modelId: number; versionId: number; modelType: ModelType; deadline?: Date };
