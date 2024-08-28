import React from 'react';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { UserMediaInfinite } from '~/components/Image/Infinite/UserMediaInfinite';
import { UserProfileLayout } from '~/components/Profile/old/OldProfileLayout';

// We re-use the component above in the index for old profile. Hence, we need to wrap it and export it here too.
const UserImagesPageWrap = () => <UserMediaInfinite type="image" />;
setPageOptions(UserImagesPageWrap, { innerLayout: UserProfileLayout });

export default UserImagesPageWrap;
