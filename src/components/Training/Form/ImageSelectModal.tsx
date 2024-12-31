import { Center, CloseButton, Divider, Loader, Modal, Text } from '@mantine/core';
import React from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { ImageSelectSource } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { useSearchLayoutStyles } from '~/components/Search/SearchLayout';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsMobile } from '~/hooks/useIsMobile';

export default function ResourceSelectModal({
  title,
  onSelect,
  onClose,
  selectSource = 'generation',
}: {
  title?: React.ReactNode;
  onSelect: (images: number[]) => void;
  onClose?: () => void;
  selectSource?: ImageSelectSource;
}) {
  const dialog = useDialogContext();
  const isMobile = useIsMobile();
  const currentUser = useCurrentUser();
  const { classes } = useSearchLayoutStyles();

  // const [selectFilters, setSelectFilters] = useState<ResourceFilter>({ types: [], baseModels: [] });

  function handleSelect(value: number[]) {
    onSelect(value);
    dialog.onClose();
  }

  function handleClose() {
    dialog.onClose();
    onClose?.();
  }

  return (
    <Modal {...dialog} onClose={handleClose} size={1200} withCloseButton={false} padding={0}>
      <div className="flex size-full max-h-full max-w-full flex-col">
        <div className="sticky top-[-48px] z-30 flex flex-col gap-3 bg-gray-0 p-3 dark:bg-dark-7">
          <div className="flex flex-wrap items-center justify-between gap-4 sm:gap-10">
            <Text>{title}</Text>
            {/*<CustomSearchBox*/}
            {/*  isMobile={isMobile}*/}
            {/*  autoFocus*/}
            {/*  className="order-last w-full grow sm:order-none sm:w-auto"*/}
            {/*/>*/}
            <CloseButton onClick={handleClose} />
          </div>

          {/*<div className="flex flex-col gap-3 sm:flex-row sm:flex-nowrap sm:items-center sm:justify-between sm:gap-10">*/}
          {/*    <ResourceSelectSort />*/}
          {/*    <ResourceSelectFiltersDropdown*/}
          {/*      options={options}*/}
          {/*      selectFilters={selectFilters}*/}
          {/*      setSelectFilters={setSelectFilters}*/}
          {/*    />*/}
          {/*</div>*/}

          <Divider />
        </div>

        {isRefetching || isLoading ? (
          <div className="p-3 py-5">
            <Center mt="md">
              <Loader />
            </Center>
          </div>
        ) : (
          <div className="flex flex-col gap-3 p-3">
            <div className={classes.grid}>
              {filtered
                .filter((model) => model.versions.length > 0)
                .map((model) => (
                  <ResourceSelectCard
                    key={model.id}
                    data={model}
                    isFavorite={!!likes && likes.includes(model.id)}
                  />
                ))}
            </div>
            {hasNextPage && (
              <InViewLoader loadFn={fetchNextPage} loadCondition={!isRefetching && hasNextPage}>
                <Center p="xl" sx={{ height: 36 }} mt="md">
                  <Loader />
                </Center>
              </InViewLoader>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
