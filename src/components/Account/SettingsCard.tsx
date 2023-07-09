import { Card, Divider, Group, Select, Stack, Switch, Title } from '@mantine/core';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { constants } from '~/server/common/constants';
import { showSuccessNotification } from '~/utils/notifications';
import { titleCase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const validModelFormats = constants.modelFileFormats.filter((format) => format !== 'Other');

export function SettingsCard() {
  const user = useCurrentUser();
  const utils = trpc.useContext();
  const { toggles } = useFeatureFlags();

  const { mutate, isLoading } = trpc.user.update.useMutation({
    async onSuccess() {
      await utils.model.getAll.invalidate();
      await utils.review.getAll.invalidate();
      user?.refresh();
      showSuccessNotification({ message: 'User profile updated' });
    },
  });

  if (!user) return null;

  return (
    <Card withBorder>
      <Stack>
        <Title order={2}>Browsing Settings</Title>
        <Divider label="Image Preferences" mb={-12} />
        <Group noWrap grow>
          <Switch
            name="autoplayGifs"
            label="Autoplay GIFs"
            checked={user.autoplayGifs}
            disabled={isLoading}
            onChange={(e) => mutate({ id: user.id, autoplayGifs: e.target.checked })}
          />
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
            label="Preferred FP"
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
        {toggles.available.length > 0 && (
          <>
            <Divider label="Early Access Features" mb={-12} />
            {toggles.available.map((feature) => (
              <Switch
                name={feature.key}
                key={feature.key}
                label={feature.displayName}
                checked={toggles.values[feature.key]}
                onChange={(e) => toggles.set(feature.key, e.target.checked)}
                description={feature.description}
              />
            ))}
          </>
        )}
      </Stack>
    </Card>
  );
}
