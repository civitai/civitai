import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { userPageQuerySchema } from '~/server/schema/user.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SidebarLayout } from '~/components/Profile/SidebarLayout';
import { trpc } from '~/utils/trpc';
import { Center, Container, Loader, Stack, Text, ThemeIcon, useMantineTheme } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { ProfileSidebar } from '~/components/Profile/ProfileSidebar';
import { ImageGuard } from '~/components/ImageGuard/ImageGuard';
import { MediaHash } from '~/components/ImageHash/ImageHash';
import { ImagePreview } from '~/components/ImagePreview/ImagePreview';
import { constants } from '~/server/common/constants';
import { useMemo } from 'react';
import {
  getAllAvailableProfileSections,
  ProfileSectionComponent,
  shouldDisplayUserNullState,
} from '~/components/Profile/profile.utils';
import { ProfileSectionSchema, ProfileSectionType } from '~/server/schema/user-profile.schema';
import { IconCloudOff } from '@tabler/icons-react';
import { ProfileHeader } from '~/components/Profile/ProfileHeader';

export function ProfileLayout({
  username,
  children,
}: {
  username: string;
  children: React.ReactNode;
}) {
  const { isLoading, data: user } = trpc.userProfile.get.useQuery({
    username,
  });

  if (isLoading) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  if (!user || !user.username) {
    return <NotFound />;
  }

  return (
    <>
      <SidebarLayout.Root>
        <SidebarLayout.Sidebar>
          <ProfileSidebar username={username} />
        </SidebarLayout.Sidebar>
        <SidebarLayout.Content>
          <Center>
            <Container fluid w="100%">
              {children}
            </Container>
          </Center>
        </SidebarLayout.Content>
      </SidebarLayout.Root>
    </>
  );
}

export default ProfileLayout;
