import React from 'react';

import { AdContent } from '~/components/Account/AdContent';
import { HiddenTagsSection } from '~/components/Account/HiddenTagsSection';
import { HiddenUsersSection } from '~/components/Account/HiddenUsersSection';
import { MatureContentSettings } from '~/components/Account/MatureContentSettings';
import { SettingRow, SettingsSection, SettingsStack } from '~/components/Account/SettingsLayout';
import { BrowsingCategories } from '~/components/BrowsingMode/BrowsingCategories';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function ContentPane() {
  const features = useFeatureFlags();
  const currentUser = useCurrentUser();

  return (
    <SettingsStack>
          {features.canViewNsfw && (
            <SettingsSection
              title="Mature content"
              description="The eye button in the header changes this for one session. This is the default it returns to."
            >
              <SettingRow block>
                <MatureContentSettings />
              </SettingRow>
            </SettingsSection>
          )}

          <SettingsSection
            title="Topics"
            description="See less of a topic while browsing. Selecting one reduces it rather than removing it."
          >
            <SettingRow block>
              <BrowsingCategories />
            </SettingRow>
          </SettingsSection>
          {/* These three still carry their own heading and panel. Flattening them the way
              SettingsCard was flattened is the remaining half of this pane; until then a section
              title here would render twice. */}
          <HiddenTagsSection />
          <HiddenUsersSection />
          {currentUser?.isMember && <AdContent />}
    </SettingsStack>
  );
}
