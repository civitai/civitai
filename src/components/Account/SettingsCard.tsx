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
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useUserSettings } from '~/providers/UserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
  // const queryUtils = trpc.useUtils();
  const flags = useFeatureFlags();

  // const { mutate, isLoading } = trpc.user.update.useMutation({
  //   async onSuccess() {
  //     await queryUtils.model.getAll.invalidate();
  //     await user?.refresh();
  //     showSuccessNotification({ message: 'User profile updated' });
  //   },
  // });

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
