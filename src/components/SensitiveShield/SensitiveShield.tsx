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

export function SensitiveShield({
  children,
  nsfw,
  contentNsfwLevel,
}: {
  children: React.ReactNode;
  nsfw?: boolean;
  contentNsfwLevel: number;
}) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { canViewNsfw } = useFeatureFlags();

  // this content is not available on this site
  if (!canViewNsfw && (nsfw || !hasPublicBrowsingLevel(contentNsfwLevel)))
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <Text>This content is not available on this site</Text>
      </div>
    );
  if (!currentUser && !hasSafeBrowsingLevel(contentNsfwLevel))
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 p-3">
          <IconEyeOff size={56} />
          <Text size="xl" weight={500}>
            Sensitive Content
          </Text>
          <Text>This content has been marked as NSFW</Text>
          <Button
            component={Link}
            href={`/login?returnUrl=${router.asPath}`}
            leftIcon={<IconKey />}
          >
            Log in to view
          </Button>
        </div>
      </div>
    );

  return <>{children}</>;
}
