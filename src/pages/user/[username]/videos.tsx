import React from 'react';
import { Page } from '~/components/AppLayout/Page';
import { UserMediaInfinite } from '~/components/Image/Infinite/UserMediaInfinite';
import { UserProfileLayout } from '~/components/Profile/old/OldProfileLayout';

export default Page(
  function () {
    return <UserMediaInfinite type="video" />;
  },
  { getLayout: UserProfileLayout }
);
