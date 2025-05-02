import {
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
} from '@mantine/core';
import { IconChevronDown, IconFilter } from '@tabler/icons-react';
import { uniq } from 'lodash-es';
import React, { useState } from 'react';
import type { ImageSelectFilter } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { useFilterStyles } from '~/components/ImageGeneration/GenerationForm/ResourceSelectFilters';
import { trainingStatusFields } from '~/components/User/UserTrainingModels';
import useIsClient from '~/hooks/useIsClient';
import { useIsMobile } from '~/hooks/useIsMobile';
import { BaseModel, constants } from '~/server/common/constants';
import type { TrainingDetailsObj } from '~/server/schema/model-version.schema';
import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { titleCase } from '~/utils/string-helpers';
import { trainingModelInfo } from '~/utils/training';
import { isDefined } from '~/utils/type-guards';

export function ImageSelectFiltersTrainingDropdown({
  selectFilters,
  setSelectFilters,
}: {
  selectFilters: ImageSelectFilter;
  setSelectFilters: React.Dispatch<React.SetStateAction<ImageSelectFilter>>;
}) {
  const { classes, theme, cx } = useFilterStyles();
  const mobile = useIsMobile();
  const isClient = useIsClient();

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
    const reset: Required<ImageSelectFilter> = {
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
      showZero={false}
      dot={false}
      classNames={{ root: classes.indicatorRoot, indicator: classes.indicatorIndicator }}
      inline
    >
      <Button
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
        <Divider label="Labels" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip
          {...chipProps}
          checked={selectFilters.hasLabels === true}
          onChange={(checked) => setSelectFilters((f) => ({ ...f, hasLabels: checked }))}
          my={4}
        >
          <span>Has Labels</span>
        </Chip>

        <Divider label="Label Type" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Group spacing={8} my={4}>
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

        <Divider label="Training Status" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={selectFilters.statuses}
          onChange={(sts: TrainingStatus[]) => setSelectFilters((f) => ({ ...f, statuses: sts }))}
          multiple
          my={4}
        >
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
        </Chip.Group>

        <Divider label="Media Type" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={selectFilters.mediaTypes}
          onChange={(ts: TrainingDetailsObj['mediaType'][]) =>
            setSelectFilters((f) => ({ ...f, mediaTypes: ts }))
          }
          multiple
          my={4}
        >
          {constants.trainingMediaTypes.map((ty) => (
            <Chip key={ty} value={ty} {...chipProps}>
              <span>{titleCase(ty)}</span>
            </Chip>
          ))}
        </Chip.Group>

        <Divider label="Type" labelProps={{ weight: 'bold', size: 'sm' }} />
        <Chip.Group
          spacing={8}
          value={selectFilters.types}
          onChange={(ts: TrainingDetailsObj['type'][]) =>
            setSelectFilters((f) => ({ ...f, types: ts }))
          }
          multiple
          my={4}
        >
          {constants.trainingModelTypes.map((ty) => (
            <Chip key={ty} value={ty} {...chipProps}>
              <span>{ty}</span>
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
          {baseModelsList.map((baseModel, index) => (
            <Chip key={index} value={baseModel} {...chipProps}>
              <span>{baseModel}</span>
            </Chip>
          ))}
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
