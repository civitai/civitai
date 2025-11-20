import type { ChipProps } from '@mantine/core';
import {
  Button,
  Chip,
  Divider,
  Drawer,
  Group,
  Indicator,
  Popover,
  ScrollArea,
  Stack,
  useComputedColorScheme,
} from '@mantine/core';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { uniq } from 'lodash-es';
import React, { useState } from 'react';
import { FilterChip } from '~/components/Filters/FilterChip';
import type {
  ImageSelectProfileFilter,
  ImageSelectTrainingFilter,
} from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { trainingStatusFields } from '~/shared/constants/training.constants';
import useIsClient from '~/hooks/useIsClient';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { BaseModel } from '~/shared/constants/base-model.constants';
import { constants } from '~/server/common/constants';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { MediaType, TrainingStatus } from '~/shared/utils/prisma/enums';
import { titleCase } from '~/utils/string-helpers';
import { trainingModelInfo } from '~/utils/training';
import { isDefined } from '~/utils/type-guards';
import classes from './ImageSelectFilters.module.scss';

export function ImageSelectFiltersTrainingDropdown({
  selectFilters,
  setSelectFilters,
}: {
  selectFilters: ImageSelectTrainingFilter;
  setSelectFilters: React.Dispatch<React.SetStateAction<ImageSelectTrainingFilter>>;
}) {
  const mobile = useIsMobile();
  const isClient = useIsClient();
  const colorScheme = useComputedColorScheme('dark');

  const [opened, setOpened] = useState(false);

  const baseModelsList = uniq(Object.values(trainingModelInfo).map((v) => v.baseModel));

  // TODO add image/video?
  const filterLength =
    (selectFilters.hasLabels === true ? 1 : 0) +
    (isDefined(selectFilters.labelType) ? 1 : 0) +
    ((selectFilters.statuses?.length ?? 0) > 0 ? 1 : 0) +
    ((selectFilters.types?.length ?? 0) > 0 ? 1 : 0) +
    ((selectFilters.mediaTypes?.length ?? 0) > 0 ? 1 : 0) +
    ((selectFilters.baseModels?.length ?? 0) > 0 ? 1 : 0);

  const clearFilters = () => {
    const reset: Required<ImageSelectTrainingFilter> = {
      hasLabels: null,
      labelType: null,
      statuses: [],
      types: [],
      mediaTypes: [],
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
      disabled={!filterLength}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        color="gray"
        radius="xl"
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        rightSection={<IconChevronDown className={opened ? classes.opened : undefined} size={16} />}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
        size="compact-sm"
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
        <Divider label="Labels" classNames={{ label: 'font-bold text-sm' }} />
        <Chip
          {...chipProps}
          checked={selectFilters.hasLabels === true}
          onChange={(checked) => setSelectFilters((f) => ({ ...f, hasLabels: checked }))}
          my={4}
        >
          <span>Has Labels</span>
        </Chip>

        <Divider label="Label Type" classNames={{ label: 'font-bold text-sm' }} />
        <Group gap={8} my={4}>
          {constants.autoLabel.labelTypes.map((lt) => (
            <Chip
              {...chipProps}
              key={lt}
              checked={selectFilters.labelType === lt}
              onChange={(checked) =>
                setSelectFilters((f) => ({ ...f, labelType: checked ? lt : null }))
              }
            >
              <span>{lt}</span>
            </Chip>
          ))}
        </Group>

        <Divider label="Training Status" classNames={{ label: 'font-bold text-sm' }} />
        <Chip.Group
          value={selectFilters.statuses}
          onChange={(sts) => setSelectFilters((f) => ({ ...f, statuses: sts as TrainingStatus[] }))}
          multiple
        >
          <Group gap={8} my={4}>
            {Object.values(TrainingStatus).map((ts) => (
              <Chip
                key={ts}
                value={ts}
                {...chipProps}
                color={trainingStatusFields[ts]?.color ?? 'gray'}
              >
                <span>{ts === 'InReview' ? 'Ready' : ts}</span>
              </Chip>
            ))}
          </Group>
        </Chip.Group>

        <Divider label="Media Type" classNames={{ label: 'font-bold text-sm' }} />
        <Chip.Group
          value={selectFilters.mediaTypes}
          onChange={(ts) =>
            setSelectFilters((f) => ({ ...f, mediaTypes: ts as TrainingDetailsObj['mediaType'][] }))
          }
          multiple
        >
          <Group gap={8} my={4}>
            {constants.trainingMediaTypes.map((ty) => (
              <Chip key={ty} value={ty} {...chipProps}>
                <span>{titleCase(ty)}</span>
              </Chip>
            ))}
          </Group>
        </Chip.Group>

        <Divider label="Type" classNames={{ label: 'font-bold text-sm' }} />
        <Chip.Group
          value={selectFilters.types}
          onChange={(ts) =>
            setSelectFilters((f) => ({ ...f, types: ts as TrainingDetailsObj['type'][] }))
          }
          multiple
        >
          <Group gap={8} my={4}>
            {constants.trainingModelTypes.map((ty) => (
              <Chip key={ty} value={ty} {...chipProps}>
                <span>{ty}</span>
              </Chip>
            ))}
          </Group>
        </Chip.Group>

        <Divider label="Base model" classNames={{ label: 'font-bold text-sm' }} />
        <Chip.Group
          value={selectFilters.baseModels}
          onChange={(bms) => setSelectFilters((f) => ({ ...f, baseModels: bms as BaseModel[] }))}
          multiple
        >
          <Group gap={8} my={4}>
            {baseModelsList.map((baseModel, index) => (
              <Chip key={index} value={baseModel} {...chipProps}>
                <span>{baseModel}</span>
              </Chip>
            ))}
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
          classNames={{
            root: classes.root,
            content: classes.content,
            body: classes.body,
            header: classes.header,
            close: classes.close,
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

export function ImageSelectFiltersProfileDropdown({
  selectFilters,
  setSelectFilters,
}: {
  selectFilters: ImageSelectProfileFilter;
  setSelectFilters: React.Dispatch<React.SetStateAction<ImageSelectProfileFilter>>;
}) {
  const mobile = useIsMobile();
  const isClient = useIsClient();
  const colorScheme = useComputedColorScheme('dark');

  const [opened, setOpened] = useState(false);

  const filterLength = (selectFilters.mediaTypes?.length ?? 0) > 0 ? 1 : 0;

  const clearFilters = () => {
    const reset: ImageSelectProfileFilter = {
      mediaTypes: [],
    };
    setSelectFilters(reset);
  };

  const target = (
    <Indicator
      offset={4}
      label={isClient && filterLength ? filterLength : undefined}
      size={16}
      zIndex={10}
      disabled={!filterLength}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
        color="gray"
        radius="xl"
        variant={colorScheme === 'dark' ? 'filled' : 'light'}
        rightSection={<IconChevronDown className={opened ? classes.opened : undefined} size={16} />}
        onClick={() => setOpened((o) => !o)}
        data-expanded={opened}
        size="compact-sm"
      >
        <Group gap={4} className="flex-nowrap">
          <IconFilter size={16} />
          Filters
        </Group>
      </Button>
    </Indicator>
  );

  const dropdown = (
    <Stack gap="lg" p="md">
      <Stack gap="md">
        <Divider label="Media Type" className="text-sm font-bold" />
        <div className="flex gap-2">
          <FilterChip
            checked={!selectFilters.mediaTypes.length}
            onChange={() => setSelectFilters({ mediaTypes: [] })}
          >
            All
          </FilterChip>
          <FilterChip
            checked={selectFilters.mediaTypes.includes(MediaType.image) ?? false}
            onChange={() => setSelectFilters({ mediaTypes: [MediaType.image] })}
          >
            Images
          </FilterChip>
          <FilterChip
            checked={selectFilters.mediaTypes.includes(MediaType.video) ?? false}
            onChange={() => setSelectFilters({ mediaTypes: [MediaType.video] })}
          >
            Videos
          </FilterChip>
        </div>
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
          classNames={{
            root: classes.root,
            content: classes.content,
            body: classes.body,
            header: classes.header,
            close: classes.close,
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
    >
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown maw={468} p={0} w="100%">
        <ScrollArea.Autosize type="hover" mah="calc(90vh - var(--header-height) - 56px)">
          {dropdown}
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}
