import { Switch } from '@mantine/core';
import React from 'react';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { SettingRow, SettingsSection } from '~/components/Account/SettingsLayout';

export function AdContent({ flat }: { flat?: boolean } = {}) {
  const allowAds = useBrowsingSettings((x) => x.allowAds);
  const setState = useBrowsingSettings((x) => x.setState);

  // BrowserSettingsProvider persists the store on a debounce; a mutation here would double-write.
  const handleToggleAds: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    setState({ allowAds: e.target.checked });
  };

  if (flat)
    return (
      <SettingsSection title="Ads">
        <SettingRow
          label="Allow on-site ads"
          description="Supports the site."
          control={
            <Switch
              checked={allowAds}
              onChange={handleToggleAds}
            />
          }
        />
      </SettingsSection>
    );

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
