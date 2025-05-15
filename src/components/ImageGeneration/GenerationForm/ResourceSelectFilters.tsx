import {
  ActionIcon,
  Button,
  Chip,
  ChipProps,
  Divider,
  Drawer,
  Group,
  Indicator,
  Popover,
  ScrollArea,
  Stack,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp, IconFilter } from '@tabler/icons-react';
import { uniq } from 'lodash-es';
import React, { useState } from 'react';
import { useSortBy } from 'react-instantsearch';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal2';
import {
  ResourceFilter,
  resourceSort,
  ResourceSort,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import useIsClient from '~/hooks/useIsClient';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { activeBaseModels, BaseModel } from '~/server/common/constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import { sortByModelTypes } from '~/utils/array-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import classes from './ResourceSelectFilters.module.scss';
import clsx from 'clsx';

const baseModelLimit = 4;

export function ResourceSelectFiltersDropdown() {
  const {
    resources,
    filters: selectFilters,
    setFilters: setSelectFilters,
  } = useResourceSelectContext();
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const mobile = useIsMobile();
  const isClient = useIsClient();

  const [opened, setOpened] = useState(false);
  const [truncateBaseModels, setTruncateBaseModels] = useLocalStorage({
    key: 'image-filter-truncate-base-models',
    defaultValue: false,
  });

  let resourceTypesList = sortByModelTypes(
    (resources?.length ? resources.map((r) => r.type) : Object.values(ModelType)).map((rt) => ({
      modelType: rt as ModelType,
    }))
  );
  let baseModelsList = resources?.length
    ? uniq(resources.flatMap((r) => (r.baseModels ?? []) as BaseModel[]))
    : activeBaseModels;
  if (!resourceTypesList.length)
    resourceTypesList = Object.values(ModelType).map((rt) => ({ modelType: rt as ModelType }));
  if (!baseModelsList.length) baseModelsList = activeBaseModels;

  const displayedBaseModels = truncateBaseModels
    ? baseModelsList.filter(
        (bm, idx) => idx < baseModelLimit || selectFilters.baseModels.includes(bm)
      )
    : baseModelsList;

  const filterLength =
    (selectFilters.types.length > 0 ? 1 : 0) + (selectFilters.baseModels.length > 0 ? 1 : 0);

  const clearFilters = () => {
    const reset: Required<ResourceFilter> = {
      types: [],
      baseModels: [],
    };
    setSelectFilters(reset);
  };

  const chipProps: Partial<ChipProps> = {
    size: 'sm',
    radius: 'xl',
    variant: 'filled',
    classNames: classes,
    tt: 'capitalize',
  };

  const target = (
    <Indicator
      offset={4}
      label={isClient && filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        // className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        rightIcon={<IconChevronDown className={clsx({ [classes.opened]: opened })} size={16} />}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
        size="compact-md"
      >
        <Group gap={4} wrap="nowrap">
          <IconFilter size={16} />
          Filters
        </Group>
      </Button>
    </Indicator>
  );

  const dropdown = (
    <Stack gap="lg" p="md">
      <Stack gap="md">
        <Divider label="Resource types" className="text-sm font-bold" />
        <Chip.Group
          value={selectFilters.types}
          onChange={(rts) => setSelectFilters((f) => ({ ...f, types: rts as ModelType[] }))}
          multiple
        >
          <Group gap={8} my={4}>
            {resourceTypesList.map((rt, index) => (
              <Chip key={index} value={rt.modelType} {...chipProps}>
                <span>{getDisplayName(rt.modelType)}</span>
              </Chip>
            ))}
          </Group>
        </Chip.Group>
        <Divider label="Base model" className="text-sm font-bold" />
        <Chip.Group
          value={selectFilters.baseModels}
          onChange={(bms) => setSelectFilters((f) => ({ ...f, baseModels: bms as BaseModel[] }))}
          multiple
        >
          {' '}
          <Group gap={8} my={4}>
            {displayedBaseModels.map((baseModel, index) => (
              <Chip key={index} value={baseModel} {...chipProps}>
                <span>{baseModel}</span>
              </Chip>
            ))}
            {baseModelsList.length > baseModelLimit && (
              <ActionIcon
                variant="transparent"
                size="sm"
                onClick={() => setTruncateBaseModels((prev) => !prev)}
              >
                {truncateBaseModels ? (
                  <IconChevronDown strokeWidth={3} />
                ) : (
                  <IconChevronUp strokeWidth={3} />
                )}
              </ActionIcon>
            )}
          </Group>
        </Chip.Group>
      </Stack>

      {filterLength > 0 && (
        <Button
          color="gray"
          variant={colorScheme === 'dark' ? 'filled' : 'light'}
          onClick={clearFilters}
          fullWidth
        >
          Clear all filters
        </Button>
      )}
    </Stack>
  );

  if (mobile)
    return (
      <>
        {target}
        <Drawer
          opened={opened}
          onClose={() => setOpened(false)}
          size="90%"
          position="bottom"
          styles={{
            content: {
              zIndex: 400,
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
              overflowY: 'auto',
            },
            body: { padding: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
            close: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
          }}
        >
          {dropdown}
        </Drawer>
      </>
    );

  return (
    <Popover
      zIndex={200}
      position="bottom-end"
      shadow="md"
      radius={12}
      onClose={() => setOpened(false)}
      middlewares={{ flip: true, shift: true }}
      // withinPortal
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p={0} w="100%">
        <ScrollArea.Autosize type="hover" mah={'calc(90vh - var(--header-height) - 56px)'}>
          {dropdown}
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}

export function ResourceSelectSort() {
  const { canViewNsfw } = useFeatureFlags();
  const { currentRefinement, options, refine } = useSortBy({
    items: Object.entries(resourceSort)
      .map(([k, v]) => ({ label: v, value: k }))
      .filter((x) => {
        return !(!canViewNsfw && x.label === 'Newest');
      }),
  });

  return (
    <SelectMenuV2
      label={resourceSort[currentRefinement as ResourceSort]}
      value={currentRefinement}
      onClick={refine}
      options={options}
    />
  );
}
