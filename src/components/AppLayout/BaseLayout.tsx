import dynamic from 'next/dynamic';
import React from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import { GenerationSidebar } from '~/components/ImageGeneration/GenerationSidebar';
import { MetaPWA } from '~/components/Meta/MetaPWA';
import { useGetRequiredOnboardingSteps } from '~/components/Onboarding/onboarding.utils';
 import { useCurrentUser } from '~/hooks/useCurrentUser';
import { Flags } from '~/shared/utils';

const UserBanned = dynamic(() => import('~/components/User/UserBanned'));
const OnboardingWizard = dynamic(() => import('~/components/Onboarding/OnboardingWizard'));

export function BaseLayout({ children }: { children: React.ReactNode }) {
  const currentUser = useCurrentUser();
  const isBanned = currentUser?.bannedAt ?? false;
  const onboardingSteps = useGetRequiredOnboardingSteps();
  const shouldOnboard =
    // TODO: Confirm with manuel & briant this is the logic we want here.
    !!currentUser && onboardingSteps.length > 0;

  // const isClient = useIsClient();

  return (
    <>
      <MetaPWA />
      <div
        className={`flex flex-1 overflow-hidden`}
        // style={{ opacity: isClient ? 1 : 0 }}
      >
        {!isBanned && !shouldOnboard && <GenerationSidebar />}
        <ContainerProvider id="main" containerName="main" className="flex-1">
          {isBanned ? (
            <UserBanned />
          ) : shouldOnboard ? (
            <OnboardingWizard
              onComplete={() => {
                return;
              }}
            />
          ) : (
            children
          )}
        </ContainerProvider>
      </div>
    </>
  );
}
