import { Tabs } from '@mantine/core';
import { useRouter } from 'next/router';

import { NotFound } from '~/components/AppLayout/NotFound';
import { UserImagesFeed } from '~/components/User/UserImagesFeed';
import { userPageQuerySchema } from '~/server/schema/user.schema';

import { UserProfileLayout } from './';

export default function UserImagesPage() {
  const router = useRouter();
  const { username } = userPageQuerySchema.parse(router.query);

  // currently not showing any content if the username is undefined
  if (!username) return <NotFound />;

  return (
    <Tabs.Panel value="/images">
      <UserImagesFeed username={username} />
    </Tabs.Panel>
  );
}

UserImagesPage.getLayout = UserProfileLayout;
