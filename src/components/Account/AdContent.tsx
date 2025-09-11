import { Switch } from '@mantine/core';
import React from 'react';
import { useUserSettings } from '~/providers/UserSettingsProvider';

export function AdContent() {
  const allowAds = useUserSettings((x) => x.allowAds);
  const setState = useUserSettings((x) => x.setState);

  const handleToggleAds: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    setState({ allowAds: e.target.checked });
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
        />
      </div>
    </div>
  );
}
