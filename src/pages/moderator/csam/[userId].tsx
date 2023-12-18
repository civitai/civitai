import { useRouter } from 'next/router';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { CsamImageSelection } from '~/components/Csam/CsamImageSelection';
import { NoContent } from '~/components/NoContent/NoContent';
import React from 'react';
import { CsamDetailsForm } from '~/components/Csam/CsamDetailsForm';
import { CsamProvider } from '~/components/Csam/CsamProvider';
import { Stepper } from '~/components/Stepper/Stepper';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { NotFound } from '~/components/AppLayout/NotFound';

export default function ReportCsamUserPage() {
  const router = useRouter();
  const userId = router.query.userId ? Number(router.query.userId) : undefined; // user being reported
  const imageId = router.query.imageId ? Number(router.query.imageId) : undefined; // default selected image

  const { csamReports } = useFeatureFlags();

  if (!csamReports) return <NotFound />;
  if (!userId) return <NoContent message="no user to report"></NoContent>;

  return (
    <CsamProvider userId={userId ?? -1}>
      <Stepper
        onComplete={() => router.push('/moderator/csam')}
        steps={[
          {
            hidden: !userId,
            render: CsamImageSelection,
            props: { imageId },
          },
          {
            render: CsamDetailsForm,
          },
        ]}
      />
    </CsamProvider>
  );
}

setPageOptions(ReportCsamUserPage, { withScrollArea: false });
