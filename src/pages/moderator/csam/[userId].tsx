import { useRouter } from 'next/router';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { CsamImageSelection } from '~/components/Csam/CsamImageSelection';
import React, { useRef } from 'react';
import { CsamDetailsForm } from '~/components/Csam/CsamDetailsForm';
import { CsamProvider } from '~/components/Csam/CsamProvider';
import { Stepper } from '~/components/Stepper/Stepper';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NotFound } from '~/components/AppLayout/NotFound';
import { z } from 'zod';
import { Text, Card, Badge, Group } from '@mantine/core';
import { useStepper } from '~/hooks/useStepper';
import { trpc } from '~/utils/trpc';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import Link from 'next/link';

export default function ReportCsamUserPage() {
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
      stepper.reset();
    } else {
      router.replace('/moderator/csam');
    }
  };

  const { data: user } = trpc.user.getById.useQuery({ id: userId });
  const stepper = useStepper({
    onComplete: handleStepperComplete,
    steps: [{ render: CsamImageSelection }, { render: CsamDetailsForm }],
  });

  if (!csamReports) return <NotFound />;
  if (!user) return <PageLoader />;

  const progress = userCountRef.current - userIds.length;

  return (
    <CsamProvider user={user}>
      {userCountRef.current > 1 && (
        <Card py={4}>
          <Group position="center">
            <Badge>
              Reporting: {progress + 1} / {userCountRef.current}
            </Badge>
            <Text size="xs" align="center">
              User:{' '}
              <Text component={Link} variant="link" href={`/user/${user.username}`}>
                {user.username}
              </Text>
            </Text>
          </Group>
        </Card>
      )}
      <Stepper stepper={stepper} />
    </CsamProvider>
  );
}

setPageOptions(ReportCsamUserPage, { withScrollArea: false });
