import { Switch } from '@mantine/core';
import React from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useMutateUserSettings } from '~/components/UserSettings/hooks';

export function AdContent() {
  const currentUser = useCurrentUser();
  const allowAds = useBrowsingSettings((x) => x.allowAds);
  const setState = useBrowsingSettings((x) => x.setState);

  const updateUserSettingsMutation = useMutateUserSettings({
    async onSuccess() {
      await currentUser?.refresh();
    },
    onError(error) {
      setState((state) => ({ allowAds: !state.allowAds }));
    },
  });

  const handleToggleAds: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    setState({ allowAds: e.target.checked });
    // updateUserSettingsMutation.mutate({ allowAds: e.target.checked });
  };

  return (
    <div className="flex size-full flex-col justify-center">
      <h4 className="font-bold">Ad Content</h4>
      <p className="text-sm">Support us by allowing ads on the site while browsing</p>
      <div className="mt-2 rounded border border-solid border-dark-4 px-4 py-2.5">
        <Switch
          classNames={{
            body: 'flex-row-reverse justify-between',
            label: 'p-0 text-base',
            labelWrapper: 'w-full',
          }}
          label="Allow on-site ads"
          checked={allowAds}
          onChange={handleToggleAds}
          disabled={updateUserSettingsMutation.isLoading}
        />
      </div>
    </div>
  );
}
