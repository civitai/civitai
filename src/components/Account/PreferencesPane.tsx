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
  mediaToggleableFeatures,
  otherToggleableFeatures,
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
        {mediaToggleableFeatures.map((feature) => (
          <SettingRow block key={feature.key}>
            <ToggleableFeatures data={[feature]} />
          </SettingRow>
        ))}
      </SettingsSection>

      <SettingsSection title="Generation">
        <SettingRow block>
          <GenerationSettings />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="File preferences" description="Defaults for the download button.">
        <SettingRow
          label="Preferred image format"
          description="Used on site and for downloads."
          control={<ImageFormatSelect />}
        />
        <SettingRow label="Preferred model format" control={<ModelFileFormatSelect />} />
        <SettingRow
          label="Preferred precision"
          description="fp16 halves the size of most checkpoints."
          control={<ModelPrecisionSelect />}
        />
        {user?.filePreferences?.format === 'GGUF' && (
          <SettingRow
            label="Preferred quant type"
            description="Q8_0 is the best quality, Q2_K the smallest."
            control={<ModelQuantTypeSelect />}
          />
        )}
      </SettingsSection>

      <SettingsSection title="Features">
        {otherToggleableFeatures.map((feature) => (
          <SettingRow block key={feature.key}>
            <ToggleableFeatures data={[feature]} />
          </SettingRow>
        ))}
        {flags.assistant && (
          <SettingRow
            label="Assistant personality"
            description="Available to subscribers."
            control={<AssistantPersonalitySelect />}
          />
        )}
        {flags.buzz && (
          <SettingRow block>
            <HideBlueBuzzToggle />
          </SettingRow>
        )}
        <SettingRow block>
          <EarlyAdopterToggle />
        </SettingRow>
      </SettingsSection>
    </SettingsStack>
  );
}
