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
import produce from 'immer';
import { useCurrentUserSettings, useMutateUserSettings } from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
// import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import type { UserAssistantPersonality } from '~/server/schema/user.schema';
import { type FeatureAccess, toggleableFeatures } from '~/server/services/feature-flags.service';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const validModelFormats = constants.modelFileFormats.filter((format) => format !== 'Other');
const normalizedToggleableFeatures = toggleableFeatures.filter(
  (feature) => feature.key !== 'assistant'
);
const assistantToggleableFeatures = toggleableFeatures.filter(
  (feature) => feature.key === 'assistant'
);

export function SettingsCard() {
  const user = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const flags = useFeatureFlags();

  const { mutate, isLoading } = trpc.user.update.useMutation({
    async onSuccess() {
      await queryUtils.model.getAll.invalidate();
      await user?.refresh();
      showSuccessNotification({ message: 'User profile updated' });
    },
  });

  const { assistantPersonality } = useCurrentUserSettings();
  const { mutate: mutateSetting, isLoading: isLoadingSetting } = useMutateUserSettings();

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
            value={user.filePreferences?.imageFormat ?? 'metadata'}
            onChange={(value: string | null) =>
              mutate({
                id: user.id,
                filePreferences: { ...user.filePreferences, imageFormat: value as ImageFormat },
              })
            }
            disabled={isLoading}
          />
        </Group>

        <Divider label="Model File Preferences" mb={-12} />
        <Group wrap="nowrap" grow>
          <Select
            label="Preferred Format"
            name="fileFormat"
            data={validModelFormats}
            value={user.filePreferences?.format ?? 'SafeTensor'}
            onChange={(value: string | null) =>
              mutate({
                id: user.id,
                filePreferences: { ...user.filePreferences, format: value as ModelFileFormat },
              })
            }
            disabled={isLoading}
          />
          <Select
            label="Preferred Size"
            name="size"
            data={constants.modelFileSizes.map((size) => ({
              value: size,
              label: titleCase(size),
            }))}
            value={user.filePreferences?.size ?? 'pruned'}
            onChange={(value: string | null) =>
              mutate({
                id: user.id,
                filePreferences: { ...user.filePreferences, size: value as ModelFileSize },
              })
            }
            disabled={isLoading}
          />
          <Select
            label="Preferred Precision"
            // name="fp"
            data={constants.modelFileFp.map((value) => ({
              value,
              label: value.toUpperCase(),
            }))}
            value={user.filePreferences?.fp ?? 'fp16'}
            onChange={(value: string | null) =>
              mutate({
                id: user.id,
                filePreferences: { ...user.filePreferences, fp: value as ModelFileFp },
              })
            }
            disabled={isLoading}
          />
        </Group>
        {user.filePreferences?.format === 'GGUF' && (
          <Tooltip
            label="Quant type determines the quality/size tradeoff. Q8_0 has the best quality but largest size, Q4_K_M provides a good balance, Q2_K is smallest but lower quality."
            multiline
            w={300}
          >
            <Select
              label="Preferred Quant Type"
              name="quantType"
              data={constants.modelFileQuantTypes}
              value={user.filePreferences?.quantType ?? 'Q4_K_M'}
              onChange={(value: string | null) =>
                mutate({
                  id: user.id,
                  filePreferences: {
                    ...user.filePreferences,
                    quantType: value as ModelFileQuantType,
                  },
                })
              }
              disabled={isLoading}
            />
          </Tooltip>
        )}

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
                    disabled={isLoadingSetting || !flags.assistantPersonality}
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
                        mutateSetting({ assistantPersonality: value as UserAssistantPersonality });
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
  const autoplayGifs = useBrowsingSettings((x) => x.autoplayGifs);
  const setState = useBrowsingSettings((x) => x.setState);

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
  const flags = useFeatureFlags();
  const queryUtils = trpc.useUtils();
  const toggleFeatureFlagMutation = trpc.user.toggleFeature.useMutation({
    async onMutate(payload) {
      await queryUtils.user.getFeatureFlags.cancel();
      const prevData = queryUtils.user.getFeatureFlags.getData();

      queryUtils.user.getFeatureFlags.setData(
        undefined,
        produce((old) => {
          if (!old) return;
          old[payload.feature] = payload.value ?? !old[payload.feature];
        })
      );

      return { prevData };
    },
    async onSuccess() {
      await queryUtils.user.getFeatureFlags.invalidate();
    },
    onError(_error, _payload, context) {
      showErrorNotification({
        title: 'Failed to toggle feature',
        error: new Error('Something went wrong, please try again later.'),
      });
      queryUtils.user.getFeatureFlags.setData(undefined, context?.prevData);
    },
  });

  function toggleFlag(key: keyof FeatureAccess, value: boolean) {
    toggleFeatureFlagMutation.mutate({ feature: key, value });
  }

  return (
    <>
      {data.map((feature) => (
        <Switch
          name={feature.key}
          key={feature.key}
          label={feature.displayName}
          checked={flags[feature.key]}
          onChange={(e) => toggleFlag(feature.key, e.target.checked)}
          description={feature.description}
          styles={{ track: { flex: '0 0 1em' } }}
        />
      ))}
    </>
  );
}
