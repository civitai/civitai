import React from 'react';
import { setPageOptions } from '~/components/AppLayout/AppLayout';
import { UserMediaInfinite } from '~/components/Image/Infinite/UserInfinite';
import { UserProfileLayout } from '~/components/Profile/old/OldProfileLayout';

// We re-use the component above in the index for old profile. Hence, we need to wrap it and export it here too.
const UserVideosPageWrap = () => <UserMediaInfinite type="video" />;
setPageOptions(UserVideosPageWrap, { innerLayout: UserProfileLayout });

export default UserVideosPageWrap;
