import { Box, CloseButton, SegmentedControl, Text, TextInput } from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconSearch, IconSettings } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { GenerationSettingsPopover } from '~/components/Generation/GenerationSettings';
import {
  ResourceSelectFiltersDropdown,
  ResourceSelectSort,
} from '~/components/ImageGeneration/GenerationForm/ResourceSelectFilters';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import {
  resourceSelectTabs,
  type Tabs,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CategoryTagFilters } from './CategoryTagFilters';
import { ResourceHitList } from './ResourceHitList';

export function ResourceSelectModalContent() {
  const { title, onClose, selectSource, tab, setTab } = useResourceSelectContext();
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 300);

  let allowedTabs = resourceSelectTabs.filter((t) => {
    return !(!currentUser && ['recent', 'liked', 'mine'].includes(t));
  });
  if (!features.auctions) {
    allowedTabs = allowedTabs.filter((t) => t !== 'featured');
  }
  // The "Official" tab is the dedup nudge for component linking — surface the
  // CivitaiOfficial canonical resources only in that context, not in generation.
  if (selectSource !== 'modelVersion') {
    allowedTabs = allowedTabs.filter((t) => t !== 'official');
  }

  // A persisted tab can become disallowed (e.g. 'mine' after logout, or 'featured'
  // once auctions are off) — fall back to 'all' so we don't render a phantom tab
  // whose server restriction silently drops.
  useEffect(() => {
    if (!allowedTabs.includes(tab)) setTab('all');
  }, [allowedTabs, tab, setTab]);

  function handleClose() {
    dialog.onClose();
    onClose?.();
  }

  return (
    <>
      <div className="sticky top-0 z-30 flex flex-col gap-3 bg-gray-0 p-3 dark:bg-dark-7">
        <div className="flex flex-wrap items-center justify-between gap-4 @sm:gap-10">
          <Text>{title}</Text>
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            leftSection={<IconSearch size={18} />}
            placeholder="Search models"
            className="order-last w-full grow @sm:order-none @sm:w-auto"
            autoFocus
          />
          <CloseButton onClick={handleClose} />
        </div>

        <div className="flex flex-col gap-3 @sm:flex-row @sm:flex-nowrap @sm:items-center @sm:justify-between @sm:gap-10">
          <SegmentedControl
            value={tab}
            onChange={(v) => setTab(v as Tabs)}
            data={allowedTabs.map((v) => ({
              value: v,
              label: (
                <Box className={v === 'featured' ? 'text-yellow-7' : ''}>{v.toUpperCase()}</Box>
              ),
            }))}
            className="w-full shrink-0 @sm:w-auto"
          />
          <CategoryTagFilters />
          <div className="flex shrink-0 flex-row items-center justify-end gap-3">
            {tab !== 'featured' && <ResourceSelectSort />}
            <ResourceSelectFiltersDropdown />
            <GenerationSettingsPopover>
              <LegacyActionIcon>
                <IconSettings />
              </LegacyActionIcon>
            </GenerationSettingsPopover>
          </div>
        </div>
      </div>

      <ResourceHitList key={tab} query={debouncedSearch} />
    </>
  );
}
