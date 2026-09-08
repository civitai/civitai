import React from 'react';

import {
  AssistantPersonalitySelect,
  AutoplayGifsToggle,
  EarlyAdopterToggle,
  HideBlueBuzzToggle,
  ImageFormatSelect,
  ModelFileFormatSelect,
  ModelPrecisionSelect,
  ModelQuantTypeSelect,
  StickerMotionToggle,
  SwipeGalleryCardsToggle,
  ToggleableFeatures,
  assistantToggleableFeatures,
  normalizedToggleableFeatures,
} from '~/components/Account/SettingsCard';
import { SettingRow, SettingsSection, SettingsStack } from '~/components/Account/SettingsLayout';
import { GenerationSettings } from '~/components/Generation/GenerationSettings';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function PreferencesPane() {
  const flags = useFeatureFlags();
  const user = useCurrentUser();

  return (
    <SettingsStack>
          <SettingsSection title="Media playback">
            <SettingRow block>
              <AutoplayGifsToggle />
            </SettingRow>
            <SettingRow block>
              <SwipeGalleryCardsToggle />
            </SettingRow>
            <SettingRow block>
              <StickerMotionToggle />
            </SettingRow>
            <SettingRow
              label="Preferred image format"
              description="Used when the site can choose, and when you download."
              control={<ImageFormatSelect />}
            />
          </SettingsSection>

          <SettingsSection title="Generation">
            <SettingRow block>
              <GenerationSettings />
            </SettingRow>
          </SettingsSection>
          <SettingsSection
            title="Model files"
            description="Defaults for the download button. You can still pick per file."
          >
            <SettingRow label="Preferred format" control={<ModelFileFormatSelect />} />
            <SettingRow
              label="Preferred precision"
              description="fp16 halves the size of most checkpoints."
              control={<ModelPrecisionSelect />}
            />
            {user?.filePreferences?.format === 'GGUF' && (
              <SettingRow
                label="Preferred quant type"
                description="Quality against size. Q8_0 is the best quality, Q2_K the smallest."
                control={<ModelQuantTypeSelect />}
              />
            )}
          </SettingsSection>

          {!!assistantToggleableFeatures.length && (
            <SettingsSection title="Assistant">
              <SettingRow block>
                <ToggleableFeatures data={assistantToggleableFeatures} />
              </SettingRow>
              <SettingRow
                label="Personality"
                description="Available to subscribers."
                control={<AssistantPersonalitySelect />}
              />
            </SettingsSection>
          )}

          <SettingsSection title="Features">
            {flags.buzz && (
              <SettingRow block>
                <HideBlueBuzzToggle />
              </SettingRow>
            )}
            <SettingRow block>
              <EarlyAdopterToggle />
            </SettingRow>
            {normalizedToggleableFeatures.length > 0 && (
              <SettingRow block>
                <ToggleableFeatures data={normalizedToggleableFeatures} />
              </SettingRow>
            )}
          </SettingsSection>
    </SettingsStack>
  );
}
