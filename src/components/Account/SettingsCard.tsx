import { Card, Divider, Group, Select, Stack, Switch, Title } from '@mantine/core';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
// import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { showSuccessNotification } from '~/utils/notifications';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { FeatureAccess, toggleableFeatures } from '~/server/services/feature-flags.service';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import produce from 'immer';
import { showErrorNotification } from '~/utils/notifications';

const validModelFormats = constants.modelFileFormats.filter((format) => format !== 'Other');

export function SettingsCard() {
  const user = useCurrentUser();
  const queryUtils = trpc.useUtils();

  const { mutate, isLoading } = trpc.user.update.useMutation({
    async onSuccess() {
      await queryUtils.model.getAll.invalidate();
      await user?.refresh();
      showSuccessNotification({ message: 'User profile updated' });
    },
  });

  if (!user) return null;

  return (
    <Card withBorder id="settings">
      <Stack>
        <Title order={2}>Browsing Settings</Title>
        <Divider label="Image Preferences" mb={-12} />
        <Group noWrap grow>
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
            onChange={(value: ImageFormat) =>
              mutate({
                id: user.id,
                filePreferences: { ...user.filePreferences, imageFormat: value },
              })
            }
            disabled={isLoading}
          />
        </Group>

        <Divider label="Model File Preferences" mb={-12} />
        <Group noWrap grow>
          <Select
            label="Preferred Format"
            name="fileFormat"
            data={validModelFormats}
            value={user.filePreferences?.format ?? 'SafeTensor'}
            onChange={(value: ModelFileFormat) =>
              mutate({ id: user.id, filePreferences: { ...user.filePreferences, format: value } })
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
            onChange={(value: ModelFileSize) =>
              mutate({ id: user.id, filePreferences: { ...user.filePreferences, size: value } })
            }
            disabled={isLoading}
          />
          <Select
            label="Preferred Precision"
            name="fp"
            data={constants.modelFileFp.map((value) => ({
              value,
              label: value.toUpperCase(),
            }))}
            value={user.filePreferences?.fp ?? 'fp16'}
            onChange={(value: ModelFileFp) =>
              mutate({ id: user.id, filePreferences: { ...user.filePreferences, fp: value } })
            }
            disabled={isLoading}
          />
        </Group>
        {toggleableFeatures.length > 0 && <ToggleableFeatures />}
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

function ToggleableFeatures() {
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
      {toggleableFeatures.map((feature) => (
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
