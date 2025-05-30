import { Button, Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconEyeOff, IconKey } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  hasPublicBrowsingLevel,
  hasSafeBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { useSession } from 'next-auth/react';
import { PageLoader } from '~/components/PageLoader/PageLoader';

export function SensitiveShield({
  children,
  nsfw,
  contentNsfwLevel,
  isLoading,
}: {
  children: React.ReactNode;
  nsfw?: boolean;
  contentNsfwLevel: number;
  isLoading?: boolean;
}) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { canViewNsfw } = useFeatureFlags();
  const { status } = useSession();

  if (!hasSafeBrowsingLevel(contentNsfwLevel) && status === 'loading') return null;

  // this content is not available on this site
  if (!canViewNsfw && (nsfw || !hasPublicBrowsingLevel(contentNsfwLevel))) {
    if (isLoading) return <PageLoader />; // Makes it so that we may confirm this to be true

    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <Text>This content is not available on this site</Text>
      </div>
    );
  }
  if (!currentUser && !hasSafeBrowsingLevel(contentNsfwLevel)) {
    if (isLoading) return <PageLoader />; // Makes it so that we may confirm this to be true

    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 p-3">
          <IconEyeOff size={56} />
          <Text size="xl" fw={500}>
            Sensitive Content
          </Text>
          <Text>This content has been marked as NSFW</Text>
          <Button
            component={Link}
            href={`/login?returnUrl=${router.asPath}`}
            leftSection={<IconKey />}
          >
            Log in to view
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
