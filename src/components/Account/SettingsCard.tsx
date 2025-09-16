import {
  Badge,
  Card,
  Divider,
  Group,
  Select,
  Stack,
  Switch,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useUserSettings } from '~/providers/UserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import type { UserAssistantPersonality } from '~/server/schema/user.schema';
import { toggleableFeatures } from '~/server/services/feature-flags.service';
import { titleCase } from '~/utils/string-helpers';
import { useCallback } from 'react';

const validModelFormats = constants.modelFileFormats.filter((format) => format !== 'Other');
const normalizedToggleableFeatures = toggleableFeatures.filter(
  (feature) => feature.key !== 'assistant'
);
const assistantToggleableFeatures = toggleableFeatures.filter(
  (feature) => feature.key === 'assistant'
);

export function SettingsCard() {
  const user = useCurrentUser();
  const flags = useFeatureFlags();

  const filePreferences = useUserSettings((state) => state.filePreferences);
  const assistantPersonality = useUserSettings((state) => state.assistantPersonality);
  const setState = useUserSettings((state) => state.setState);

  if (!user) return null;

  return (
    <Card withBorder id="settings">
      <Stack>
        <Title order={2}>Browsing Settings</Title>

        <Divider label="Image Preferences" mb={-12} />
        <Group wrap="nowrap" grow>
          <AutoplayGifsToggle />
          <Select
            label="Preferred Format"
            name="imageFormat"
            data={[
              {
                value: 'optimized',
                label: 'Optimized (avif, webp)',
              },
              {
                value: 'metadata',
                label: 'Unoptimized (jpeg, png)',
              },
            ]}
            value={filePreferences?.imageFormat ?? 'metadata'}
            onChange={(value: string | null) =>
              setState((state) => ({
                filePreferences: { ...state.filePreferences, imageFormat: value as ImageFormat },
              }))
            }
          />
        </Group>

        <Divider label="Model File Preferences" mb={-12} />
        <Group wrap="nowrap" grow>
          <Select
            label="Preferred Format"
            name="fileFormat"
            data={validModelFormats}
            value={filePreferences?.format ?? 'SafeTensor'}
            onChange={(value: string | null) =>
              setState((state) => ({
                filePreferences: { ...state.filePreferences, format: value as ModelFileFormat },
              }))
            }
          />
          <Select
            label="Preferred Size"
            name="size"
            data={constants.modelFileSizes.map((size) => ({
              value: size,
              label: titleCase(size),
            }))}
            value={filePreferences?.size ?? 'pruned'}
            onChange={(value: string | null) =>
              setState((state) => ({
                filePreferences: { ...state.filePreferences, size: value as ModelFileSize },
              }))
            }
          />
          <Select
            label="Preferred Precision"
            // name="fp"
            data={constants.modelFileFp.map((value) => ({
              value,
              label: value.toUpperCase(),
            }))}
            value={filePreferences?.fp ?? 'fp16'}
            onChange={(value: string | null) =>
              setState((state) => ({
                filePreferences: { ...state.filePreferences, fp: value as ModelFileFp },
              }))
            }
          />
        </Group>

        {!!assistantToggleableFeatures && (
          <>
            <Divider label="Assistant Preferences" />
            <Stack>
              <ToggleableFeatures data={assistantToggleableFeatures} />
              <Tooltip
                withArrow
                color="gray"
                offset={-10}
                label={!flags.assistantPersonality ? 'Available to subscribers only' : undefined}
                disabled={flags.assistantPersonality}
              >
                <div>
                  <Select
                    label={
                      <Group mb={4} gap="xs">
                        <Text size="sm" fw={500}>
                          Personality
                        </Text>
                        {new Date() < new Date('2025-04-21') && <Badge color="green">New</Badge>}
                      </Group>
                    }
                    name="assistantPersonality"
                    data={[
                      {
                        value: 'civbot',
                        label: 'CivBot',
                      },
                      {
                        value: 'civchan',
                        label: 'CivChan',
                      },
                    ]}
                    value={assistantPersonality ?? 'civbot'}
                    onChange={(value: string | null) => {
                      if (flags.assistantPersonality) {
                        setState({ assistantPersonality: value as UserAssistantPersonality });
                      }
                    }}
                  />
                </div>
              </Tooltip>
            </Stack>
          </>
        )}

        {normalizedToggleableFeatures.length > 0 && (
          <>
            <Divider label="Features" />
            <ToggleableFeatures data={normalizedToggleableFeatures} />
          </>
        )}
      </Stack>
    </Card>
  );
}

function AutoplayGifsToggle() {
  const autoplayGifs = useUserSettings((x) => x.autoplayGifs);
  const setState = useUserSettings((x) => x.setState);

  return (
    <Switch
      name="autoplayGifs"
      label="Autoplay GIFs"
      checked={autoplayGifs}
      onChange={(e) => setState({ autoplayGifs: e.target.checked })}
    />
  );
}

function ToggleableFeatures({ data }: { data: typeof toggleableFeatures }) {
  return (
    <>
      {data.map((feature) => (
        <FeatureToggleSwitch key={feature.key} data={feature} />
      ))}
    </>
  );
}

function FeatureToggleSwitch({ data }: { data: (typeof toggleableFeatures)[number] }) {
  const setState = useUserSettings((state) => state.setState);
  const checked = useUserSettings(
    useCallback((state) => state.features?.[data.key] ?? data.default, [data.key, data.default])
  );

  function toggleFlag(value: boolean) {
    setState((state) => ({ features: { ...state.features, [data.key]: value } }));
  }

  return (
    <Switch
      name={data.key}
      key={data.key}
      label={data.displayName}
      checked={checked}
      onChange={(e) => toggleFlag(e.target.checked)}
      description={data.description}
      styles={{ track: { flex: '0 0 1em' } }}
    />
  );
}
