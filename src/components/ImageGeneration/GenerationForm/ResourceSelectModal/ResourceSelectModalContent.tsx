import { Box, Center, CloseButton, Loader, SegmentedControl, Text } from '@mantine/core';
import { IconSettings } from '@tabler/icons-react';
import { useRef } from 'react';
import { Configure, useClearRefinements } from 'react-instantsearch';
import { GenerationSettingsPopover } from '~/components/Generation/GenerationSettings';
import {
  ResourceSelectFiltersDropdown,
  ResourceSelectSort,
} from '~/components/ImageGeneration/GenerationForm/ResourceSelectFilters';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { CustomSearchBox } from '~/components/Search/CustomSearchComponents';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useStorage } from '~/hooks/useStorage';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CategoryTagFilters } from './CategoryTagFilters';
import { ResourceHitList } from './ResourceHitList';
import {
  useResourceSelectQueries,
  useResourceSelectMeiliFilters,
  type Tabs,
} from './useResourceSelectFilters';

const tabs: Tabs[] = ['all', 'featured', 'recent', 'liked', 'mine'];
const defaultTab: Tabs = 'all';
const hitsPerPage = 20;

export function ResourceSelectModalContent() {
  const { title, onClose } = useResourceSelectContext();
  const dialog = useDialogContext();
  const isMobile = useIsMobile();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const [selectedTab, setSelectedTab] = useStorage<Tabs>({
    type: 'localStorage',
    key: 'resource-select-tab',
    defaultValue: defaultTab,
    getInitialValueInEffect: false,
  });
  const { refine } = useClearRefinements();

  const {
    likedModels,
    featuredModels,
    generationData,
    trainingModels,
    manuallyAdded,
    recommendedModels,
    auctionModels,
    isLoadingExtra,
  } = useResourceSelectQueries(selectedTab ?? defaultTab);

  const totalFilters = useResourceSelectMeiliFilters({
    selectedTab: selectedTab ?? defaultTab,
    featuredModels,
    generationData,
    trainingModels,
    manuallyAdded,
    recommendedModels,
    auctionModels,
    likedModels,
  });

  let allowedTabs = tabs.filter((t) => {
    return !(!currentUser && ['recent', 'liked', 'mine'].includes(t));
  });
  if (!features.auctions) {
    allowedTabs = allowedTabs.filter((t) => t !== 'featured');
  }

  function handleClose() {
    dialog.onClose();
    onClose?.();
  }

  return (
    <>
      {totalFilters && !isLoadingExtra && (
        <Configure
          key={totalFilters}
          hitsPerPage={selectedTab === 'featured' ? 1000 : hitsPerPage}
          filters={totalFilters}
        />
      )}

      <div className="sticky top-[-48px] z-30 flex flex-col gap-3 bg-gray-0 p-3 dark:bg-dark-7">
        <div className="flex flex-wrap items-center justify-between gap-4 @sm:gap-10">
          <Text>{title}</Text>
          <CustomSearchBox
            isMobile={isMobile as boolean}
            className="order-last w-full grow @sm:order-none @sm:w-auto"
            autoFocus
          />
          <CloseButton onClick={handleClose} />
        </div>

        <div className="flex flex-col gap-3 @sm:flex-row @sm:flex-nowrap @sm:items-center @sm:justify-between @sm:gap-10">
          <SegmentedControl
            value={selectedTab}
            onChange={(v) => {
              setSelectedTab(v as Tabs);
              refine();
            }}
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
            {selectedTab !== 'featured' && <ResourceSelectSort />}
            <ResourceSelectFiltersDropdown />
            <GenerationSettingsPopover>
              <LegacyActionIcon>
                <IconSettings />
              </LegacyActionIcon>
            </GenerationSettingsPopover>
          </div>
        </div>
      </div>

      {!totalFilters || isLoadingExtra ? (
        <div className="p-3 py-5">
          <Center mt="md">
            <Loader />
          </Center>
        </div>
      ) : (
        <ResourceHitList
          key={selectedTab}
          likes={likedModels}
          featured={featuredModels}
          selectedTab={selectedTab}
        />
      )}
    </>
  );
}
