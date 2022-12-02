import { Card, Stack, Switch, Title } from '@mantine/core';
import { useSession } from 'next-auth/react';
import { reloadSession } from '~/utils/next-auth-helpers';
import { trpc } from '~/utils/trpc';

export function SettingsCard() {
  const { data: session } = useSession();
  const user = session?.user;
  const utils = trpc.useContext();

  const { mutate, isLoading } = trpc.user.update.useMutation({
    async onSuccess(user) {
      await utils.model.getAll.invalidate();
      await utils.review.getAll.invalidate();
      await reloadSession();
    },
  });

  return (
    <Card withBorder>
      <Stack>
        <Title order={2}>Settings</Title>
        <Switch
          name="showNsfw"
          label="Show me NSFW content"
          description="If you are not of legal age to view NSFW content, please do not enable this option"
          defaultChecked={user?.showNsfw}
          onChange={(e) => mutate({ id: user?.id, showNsfw: e.target.checked })}
        />
        {user?.showNsfw && (
          <Switch
            name="blurNsfw"
            label="Blur NSFW content"
            defaultChecked={user?.blurNsfw}
            onChange={(e) => mutate({ id: user?.id, blurNsfw: e.target.checked })}
          />
        )}
      </Stack>
    </Card>
  );
}
