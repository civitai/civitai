import { Button, Container, Group, Paper, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconEyeOff, IconKey } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  getIsSafeBrowsingLevel,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

export function SensitiveShield({
  children,
  enabled = true,
}: {
  children?: JSX.Element;
  enabled?: boolean;
}) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const [accepted, setAccepted] = useState(false);
  if (children && (!enabled || accepted)) return children;

  return (
    <Container size="xs">
      <Paper p="xl" radius="md" withBorder>
        <Stack align="center">
          <IconEyeOff size={56} />
          <Text size="xl" weight={500}>
            Sensitive Content
          </Text>
          <Text>This content has been marked as NSFW</Text>
          <Group>
            {children ? (
              <Button leftIcon={<IconEyeOff />} onClick={() => setAccepted(true)}>
                {`I'm over 18`}
              </Button>
            ) : !currentUser ? (
              <Button
                component={NextLink}
                href={`/login?returnUrl=${router.asPath}`}
                leftIcon={<IconKey />}
              >
                Log in to view
              </Button>
            ) : null}
          </Group>
        </Stack>
      </Paper>
    </Container>
  );
}

export function SensitiveShield2({
  children,
  contentNsfwLevel,
}: {
  children: React.ReactNode;
  contentNsfwLevel: number;
}) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const { canViewNsfw } = useFeatureFlags();
  console.log({ canViewNsfw });

  // this content is not available on this site
  if (!canViewNsfw && contentNsfwLevel > publicBrowsingLevelsFlag)
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <Text>This content is not available on this site</Text>
      </div>
    );
  if (!currentUser && !getIsSafeBrowsingLevel(contentNsfwLevel))
    return (
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 p-3">
          <IconEyeOff size={56} />
          <Text size="xl" weight={500}>
            Sensitive Content
          </Text>
          <Text>This content has been marked as NSFW</Text>
          <Button
            component={NextLink}
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
