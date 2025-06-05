import type { ChipProps } from '@mantine/core';
import {
  ActionIcon,
  Button,
  Chip,
  createStyles,
  Divider,
  Drawer,
  Group,
  Indicator,
  Popover,
  ScrollArea,
  Stack,
} from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconChevronDown, IconChevronUp, IconFilter } from '@tabler/icons-react';
import { uniq } from 'lodash-es';
import React, { useState } from 'react';
import { useSortBy } from 'react-instantsearch';
import { useResourceSelectContext } from '~/components/ImageGeneration/GenerationForm/ResourceSelectProvider';
import type {
  ResourceFilter,
  ResourceSort,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { resourceSort } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import useIsClient from '~/hooks/useIsClient';
import { useIsMobile } from '~/hooks/useIsMobile';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { BaseModel } from '~/server/common/constants';
import { activeBaseModels } from '~/server/common/constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import { sortByModelTypes } from '~/utils/array-helpers';
import { containerQuery } from '~/utils/mantine-css-helpers';
import { getDisplayName } from '~/utils/string-helpers';

export const useFilterStyles = createStyles((theme) => ({
  label: {
    fontSize: 12,
    fontWeight: 600,

    '&[data-checked]': {
      '&, &:hover': {
        color: theme.colorScheme === 'dark' ? theme.white : theme.black,
        border: `1px solid ${theme.colors[theme.primaryColor][theme.fn.primaryShade()]}`,
      },

      '&[data-variant="filled"]': {
        // color: theme.colorScheme === 'dark' ? theme.white : theme.black,
        backgroundColor: 'transparent',
      },
    },
  },
  opened: {
    transform: 'rotate(180deg)',
    transition: 'transform 200ms ease',
  },

  actionButton: {
    [containerQuery.smallerThan('sm')]: {
      width: '100%',
    },
  },

  indicatorRoot: { lineHeight: 1 },
  indicatorIndicator: { lineHeight: 1.6 },
}));

const baseModelLimit = 4;

export function ResourceSelectFiltersDropdown() {
  const {
    resources,
    filters: selectFilters,
    setFilters: setSelectFilters,
  } = useResourceSelectContext();
  const { classes, theme, cx } = useFilterStyles();
  const mobile = useIsMobile();
  const isClient = useIsClient();

  const [opened, setOpened] = useState(false);
  const [truncateBaseModels, setTruncateBaseModels] = useLocalStorage({
    key: 'image-filter-truncate-base-models',
    defaultValue: false,
  });

  let resourceTypesList = sortByModelTypes(
    [...new Set(resources?.length ? resources.map((r) => r.type) : Object.values(ModelType))].map(
      (rt) => ({
        modelType: rt as ModelType,
      })
    )
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
      showZero={false}
      dot={false}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        // className={classes.actionButton}
        color="gray"
        radius="xl"
        variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
        rightIcon={<IconChevronDown className={cx({ [classes.opened]: opened })} size={16} />}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
        compact
      >
        <Group spacing={4} noWrap>
          <IconFilter size={16} />
          Filters
        </Group>
      </Button>
    </Indicator>
  );

  const dropdown = (
    <Stack spacing="lg" p="md">
      <Stack spacing="md">
        <Divider label="Resource types" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={selectFilters.types}
          onChange={(rts: ModelType[]) => setSelectFilters((f) => ({ ...f, types: rts }))}
          multiple
          my={4}
        >
          {resourceTypesList.map((rt, index) => (
            <Chip key={index} value={rt.modelType} {...chipProps}>
              <span>{getDisplayName(rt.modelType)}</span>
            </Chip>
          ))}
        </Chip.Group>
        <Divider label="Base model" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={selectFilters.baseModels}
          onChange={(bms: BaseModel[]) => setSelectFilters((f) => ({ ...f, baseModels: bms }))}
          multiple
          my={4}
        >
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
        </Chip.Group>
      </Stack>

      {filterLength > 0 && (
        <Button
          color="gray"
          variant={theme.colorScheme === 'dark' ? 'filled' : 'light'}
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
            root: {
              zIndex: 400,
            },
            drawer: {
              height: 'auto',
              maxHeight: 'calc(100dvh - var(--header-height))',
              overflowY: 'auto',
            },
            body: { padding: 0, overflowY: 'auto' },
            header: { padding: '4px 8px' },
            closeButton: { height: 32, width: 32, '& > svg': { width: 24, height: 24 } },
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
        <ScrollArea.Autosize type="hover" maxHeight={'calc(90vh - var(--header-height) - 56px)'}>
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
