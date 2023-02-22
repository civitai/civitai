import { Card, Divider, Group, Select, Stack, Switch, Title } from '@mantine/core';
import { ModelFileFormat } from '@prisma/client';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import { reloadSession } from '~/utils/next-auth-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const validModelFormats = Object.values(ModelFileFormat).filter((format) => format !== 'Other');

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
          defaultChecked={user.autoplayGifs}
          disabled={isLoading}
          onChange={(e) => mutate({ ...user, autoplayGifs: e.target.checked })}
        />
        <Switch
          name="showNsfw"
          label="Show me adult content"
          description="If you are not of legal age to view adult content, please do not enable this option"
          defaultChecked={user.showNsfw}
          disabled={isLoading}
          onChange={(e) => mutate({ ...user, showNsfw: e.target.checked })}
        />
        {user.showNsfw && (
          <Switch
            name="blurNsfw"
            label="Blur adult content"
            defaultChecked={user.blurNsfw}
            disabled={isLoading}
            onChange={(e) => mutate({ ...user, blurNsfw: e.target.checked })}
          />
        )}
        <Divider label="Model File Preferences" mb={-12} />
        <Group noWrap grow>
          <Select
            label="Preferred Format"
            name="fileFormat"
            data={validModelFormats}
            defaultValue={user.preferredModelFormat ?? ModelFileFormat.SafeTensor}
            onChange={(value: ModelFileFormat) => mutate({ ...user, preferredModelFormat: value })}
            disabled={isLoading}
          />
          <Select
            label="Preferred Size"
            name="fileFormat"
            data={['Full', 'Pruned']}
            defaultValue={user.preferredPrunedModel ? 'Pruned' : 'Full'}
            onChange={(value) => mutate({ ...user, preferredPrunedModel: value === 'Pruned' })}
            disabled={isLoading}
          />
        </Group>
      </Stack>
    </Card>
  );
}
