import clsx from 'clsx';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import React from 'react';
import { ContainerProvider } from '~/components/ContainerProvider/ContainerProvider';
import {
  GenerationSidebar,
  useGenerationSidebarState,
} from '~/components/ImageGeneration/GenerationSidebar';
import { MetaPWA } from '~/components/Meta/MetaPWA';
import { PushRegistrationManager } from '~/components/Notifications/PushRegistrationManager';
import { useGetRequiredOnboardingSteps } from '~/components/Onboarding/onboarding.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isDev } from '~/env/other';

const UserBanned = dynamic(() => import('~/components/User/UserBanned'));
const OnboardingWizard = dynamic(() => import('~/components/Onboarding/OnboardingWizard'));

export function BaseLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const isBanned = currentUser?.bannedAt ?? false;
  const onboardingSteps = useGetRequiredOnboardingSteps();
  // Dev-only escape hatch: /dev/onboarding renders its own wizard preview.
  const skipOnboardingShield = isDev && router.pathname.startsWith('/dev/onboarding');
  const shouldOnboard =
    // TODO: Confirm with manuel & briant this is the logic we want here.
    !!currentUser && onboardingSteps.length > 0 && !skipOnboardingShield;

  const showSidebar = !isBanned && !shouldOnboard;
  const sidebarCoversPage = useGenerationSidebarState().coversPage && showSidebar;

  return (
    <>
      <MetaPWA />
      <PushRegistrationManager />
      <div className="flex flex-1 overflow-hidden">
        {showSidebar && <GenerationSidebar />}
        <ContainerProvider
          id="main"
          containerName="main"
          // Hidden, not unmounted: the page underneath can hold unsaved work (a post draft, an upload).
          className={clsx('flex-1', sidebarCoversPage && '[content-visibility:hidden]')}
        >
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
