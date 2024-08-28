import { Switch } from '@mantine/core';
import React from 'react';
import { JoinPopover } from '~/components/JoinPopover/JoinPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function AdContent() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const { data, isLoading } = trpc.user.getSettings.useQuery();

  const updateUserSettingsMutation = trpc.user.setSettings.useMutation({
    async onMutate({ allowAds }) {
      await queryUtils.user.getSettings.cancel();
      const prevData = queryUtils.user.getSettings.getData();
      queryUtils.user.getSettings.setData(undefined, (old) =>
        old ? { ...old, allowAds: allowAds ?? old.allowAds } : old
      );

      return prevData;
    },
    async onSuccess() {
      await currentUser?.refresh();
    },
    onError(error, _, context) {
      showErrorNotification({
        title: 'Failed to update settings',
        error: new Error(error.message),
      });

      if (context) queryUtils.user.getSettings.setData(undefined, context);
    },
  });

  const handleToggleAds: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const value = e.target.checked;
    updateUserSettingsMutation.mutate({ allowAds: value });
  };

  return (
    <div className="flex size-full flex-col justify-center">
      <h4 className="font-bold">Ad Content</h4>
      <p className="text-sm">Support us by allowing ads on the site while browsing</p>
      <div className="mt-2 rounded border border-solid border-dark-4 px-4 py-2.5">
        <JoinPopover trigger="onChange" message="You must be a Civitai Member to toggle off ads">
          <Switch
            classNames={{
              body: 'flex-row-reverse justify-between',
              label: 'p-0 text-base',
              labelWrapper: 'w-full',
            }}
            label="Allow on-site ads"
            checked={!!data?.allowAds}
            onChange={handleToggleAds}
            disabled={isLoading}
          />
        </JoinPopover>
      </div>
    </div>
  );
}
