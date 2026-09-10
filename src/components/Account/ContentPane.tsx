import { IconEye } from '@tabler/icons-react';
import React from 'react';

import { AdContent } from '~/components/Account/AdContent';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';
import { MatureContentSettings } from '~/components/Account/MatureContentSettings';
import {
  SettingRow,
  SettingsNote,
  SettingsSection,
  SettingsStack,
} from '~/components/Account/SettingsLayout';
import { BrowsingCategories } from '~/components/BrowsingMode/BrowsingCategories';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function ContentPane() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();

  return (
    <SettingsStack>
      {currentUser?.isMember && <AdContent flat />}

      {features.canViewNsfw && (
        <SettingsSection title="Mature content">
          <SettingsNote icon={<IconEye size={18} />}>
            The eye button in the header overrides this for one session. These are the defaults it
            returns to.
          </SettingsNote>
          <MatureContentSettings flat />
        </SettingsSection>
      )}

      <SettingsSection
        title="Topics"
        description="Selected topics appear less often while browsing."
      >
        <SettingRow block>
          <BrowsingCategories />
        </SettingRow>
      </SettingsSection>

      <HiddenTagsSection flat />
      <HiddenUsersSection flat />
    </SettingsStack>
  );
}
