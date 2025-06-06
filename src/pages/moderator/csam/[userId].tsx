import { useRouter } from 'next/router';
import { CsamImageSelection } from '~/components/Csam/CsamImageSelection';
import React, { useRef } from 'react';
import { CsamDetailsForm } from '~/components/Csam/CsamDetailsForm';
import { CsamProvider } from '~/components/Csam/CsamProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NotFound } from '~/components/AppLayout/NotFound';
import { z } from 'zod';
import { Text, Card, Badge, Group } from '@mantine/core';
import { useStepper } from '~/hooks/useStepper';
import { trpc } from '~/utils/trpc';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { Page } from '~/components/AppLayout/Page';

function ReportCsamUserPage() {
  const router = useRouter();
  const userIds = z.coerce
    .number()
    .array()
    .parse(((router.query.userId as string) ?? '').split(','));
  const userCountRef = useRef(userIds.length);

  const { csamReports } = useFeatureFlags();
  const userId = userIds[0];

  const handleStepperComplete = () => {
    if (userIds.length > 1) {
      router.replace(`/moderator/csam/${userIds.filter((id) => id !== userId).join(',')}`);
      stepperActions.reset();
    } else {
      router.replace('/moderator/csam');
    }
  };

  const { data: user } = trpc.user.getById.useQuery({ id: userId });
  const [currentStep, stepperActions] = useStepper(2);

  if (!csamReports) return <NotFound />;
  if (!user) return <PageLoader />;

  const progress = userCountRef.current - userIds.length;

  return (
    <CsamProvider user={user} type="Image">
      {userCountRef.current > 1 && (
        <Card py={4}>
          <Group justify="center">
            <Badge>
              Reporting: {progress + 1} / {userCountRef.current}
            </Badge>
            {user.username && (
              <Text size="xs" align="center">
                User:{' '}
                <Text component={Link} c="blue.4" href={`/user/${user.username}`}>
                  {user.username}
                </Text>
              </Text>
            )}
          </Group>
        </Card>
      )}
      {currentStep === 1 && (
        <CsamImageSelection
          onNext={stepperActions.goToNextStep}
          onMissing={handleStepperComplete}
        />
      )}
      {currentStep === 2 && (
        <CsamDetailsForm
          onPrevious={stepperActions.goToPrevStep}
          onSuccess={handleStepperComplete}
          userId={user.id}
          type="Image"
        />
      )}
    </CsamProvider>
  );
}

export default Page(ReportCsamUserPage, {
  footer: null,
});
