import React from 'react';
import { Button, Container, Paper, Title, Stack, Text } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';
import Image from 'next/image';
import { IconLock, IconLogout } from '@tabler/icons-react';
import { signOut } from 'next-auth/react';

export default function PreviewRestrictedPage() {
  return (
    <>
      <Meta title="Access Restricted" description="This preview environment is restricted." deIndex />
      <Container size="sm" className="py-8">
        <div className="mb-8 flex justify-center">
          <Image
            src="/images/logo_light_mode.png"
            alt="Civitai Logo"
            height={48}
            width={150}
            className="dark:hidden"
            priority
          />
          <Image
            src="/images/logo_dark_mode.png"
            alt="Civitai Logo"
            height={48}
            width={150}
            className="hidden dark:block"
            priority
          />
        </div>
        <Paper className="p-8">
          <Stack gap="md" align="center">
            <IconLock size={48} color="var(--mantine-color-yellow-6)" />
            <Title order={2} ta="center">
              Preview Environment
            </Title>
            <Text ta="center" c="dimmed" maw={400}>
              This environment is restricted to authorized testers and moderators. If you believe you
              should have access, please reach out to your team lead.
            </Text>
            <Button
              variant="light"
              leftSection={<IconLogout size={16} />}
              onClick={() => signOut({ callbackUrl: '/login' })}
            >
              Sign out and switch accounts
            </Button>
          </Stack>
        </Paper>
      </Container>
    </>
  );
}

PreviewRestrictedPage.getLayout = (page: React.ReactNode) => {
  return <>{page}</>;
};
