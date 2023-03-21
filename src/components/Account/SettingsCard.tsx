import { Card, Divider, Group, Select, Stack, Switch, Title } from '@mantine/core';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { reloadSession } from '~/utils/next-auth-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { splitUppercase } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';

const validModelFormats = constants.modelFileFormats.filter((format) => format !== 'Other');

export function SettingsCard() {
  const user = useCurrentUser();
  const utils = trpc.useContext();

  const { mutate, isLoading } = trpc.user.update.useMutation({
    async onSuccess() {
      await utils.model.getAll.invalidate();
      await utils.review.getAll.invalidate();
      await reloadSession();
      showSuccessNotification({ message: 'User profile updated' });
    },
  });

  if (!user) return null;

  return (
    <Card withBorder>
      <Stack>
        <Title order={2}>Browsing Settings</Title>
        <Switch
          name="autoplayGifs"
          label="Autoplay GIFs"
          checked={user.autoplayGifs}
          disabled={isLoading}
          onChange={(e) => mutate({ ...user, autoplayGifs: e.target.checked })}
        />
        <Divider label="Model File Preferences" mb={-12} />
        <Group noWrap grow>
          <Select
            label="Preferred Format"
            name="fileFormat"
            data={validModelFormats}
            value={user.filePreferences?.format ?? 'SafeTensor'}
            onChange={(value: ModelFileFormat) =>
              mutate({ ...user, filePreferences: { ...user.filePreferences, format: value } })
            }
            disabled={isLoading}
          />
          <Select
            label="Preferred Size"
            name="size"
            data={constants.modelFileSizes.map((size) => ({
              value: size,
              label: splitUppercase(size),
            }))}
            value={user.filePreferences?.size ?? 'pruned'}
            onChange={(value: ModelFileSize) =>
              mutate({ ...user, filePreferences: { ...user.filePreferences, size: value } })
            }
            disabled={isLoading}
          />
          <Select
            label="Preferred Floating Point"
            name="fp"
            data={constants.modelFileFp}
            value={user.filePreferences?.fp ?? 'fp16'}
            onChange={(value: ModelFileSize) =>
              mutate({ ...user, filePreferences: { ...user.filePreferences, size: value } })
            }
            disabled={isLoading}
          />
        </Group>
      </Stack>
    </Card>
  );
}
