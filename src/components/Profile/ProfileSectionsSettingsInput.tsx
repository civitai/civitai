import type { InputWrapperProps } from '@mantine/core';
import {
  ActionIcon,
  Button,
  Group,
  Input,
  Paper,
  Stack,
  Switch,
  Text,
  useComputedColorScheme,
  useMantineTheme,
} from '@mantine/core';
import React, { useState } from 'react';
import { useDidUpdate } from '@mantine/hooks';
import type {
  ProfileSectionSchema,
  ProfileSectionType,
  ShowcaseSectionSchema,
} from '~/server/schema/user-profile.schema';
import { showcaseSectionLimits } from '~/server/schema/user-profile.schema';
import { IconArrowsMoveVertical, IconPencil, IconPlus } from '@tabler/icons-react';
import {
  getAllAvailableProfileSections,
  getShowcaseSectionByKey,
  isCustomShowcaseKey,
  profileSectionLabels,
} from '~/components/Profile/profile.utils';
import { dialogStore } from '~/components/Dialog/dialogStore';
import ShowcaseSectionModal from '~/components/Profile/ShowcaseSectionModal';
import type { DragEndEvent, Modifier, UniqueIdentifier } from '@dnd-kit/core';
import { rectIntersection, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';

// Lock dragging to the vertical axis (sections only reorder up/down).
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { isEqual } from 'lodash-es';
import { withController } from '~/libs/form/hoc/withController';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

type ProfileSectionsSettingsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: ProfileSectionSchema[];
  onChange?: (value: ProfileSectionSchema[]) => void;
  showcaseSections?: ShowcaseSectionSchema[];
};

const noShowcaseSections: ShowcaseSectionSchema[] = [];

export const ProfileSectionsSettingsInput = ({
  value,
  onChange,
  showcaseSections = noShowcaseSections,
  ...props
}: ProfileSectionsSettingsInputProps) => {
  const theme = useMantineTheme();
  const features = useFeatureFlags();
  const colorScheme = useComputedColorScheme('dark');
  const [sections, setSections] = useState<ProfileSectionSchema[]>(
    getAllAvailableProfileSections(value || [], showcaseSections)
  );
  const [error, setError] = useState('');

  useDidUpdate(() => {
    if (sections) {
      onChange?.(sections);
    }
  }, [sections]);

  useDidUpdate(() => {
    if (!isEqual(value, sections)) {
      // Value changed outside.
      setSections(getAllAvailableProfileSections(value || [], showcaseSections));
    }
  }, [value]);

  useDidUpdate(() => {
    setSections((current) => getAllAvailableProfileSections(current, showcaseSections));
  }, [showcaseSections]);

  const openShowcaseSection = (sectionId?: string) =>
    dialogStore.trigger({
      component: ShowcaseSectionModal,
      props: { sections: showcaseSections, sectionId },
    });

  const onToggleSection = (key: string) => {
    setSections((current) =>
      current.map((s) => (s.key === key ? { ...s, enabled: !s.enabled } : s))
    );
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSections((items) => {
        const ids = items.map(({ key }): UniqueIdentifier => key);
        const oldIndex = ids.indexOf(active.id);
        const newIndex = ids.indexOf(over.id);
        const sorted = arrayMove(items, oldIndex, newIndex);
        return sorted;
      });
    }
  };

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      <Stack mt="md" gap="xs">
        <DndContext
          sensors={sensors}
          collisionDetection={rectIntersection}
          onDragEnd={handleDragEnd}
          modifiers={[restrictToVerticalAxis]}
        >
          <SortableContext
            items={sections.map((s) => s.key)}
            strategy={verticalListSortingStrategy}
          >
            <Stack>
              {sections.map((s) => {
                // Kept in the saved list either way; only the toggle waits for the flag.
                if (s.key === 'creatorJourney' && !features.creatorJourney) return null;
                const showcase = getShowcaseSectionByKey(s.key, showcaseSections);
                if (isCustomShowcaseKey(s.key) && (!features.profileShowcases || !showcase))
                  return null;
                const label = showcase
                  ? showcase.title
                  : profileSectionLabels[s.key as ProfileSectionType];
                return (
                  <SortableItem key={s.key} id={s.key}>
                    <Paper
                      style={{
                        backgroundColor:
                          colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
                      }}
                      withBorder
                      key={s.key}
                      p="xs"
                      radius="md"
                    >
                      <Group wrap="nowrap">
                        <IconArrowsMoveVertical />
                        <Text size="sm" lineClamp={1}>
                          {label}
                        </Text>
                        {showcase && (
                          <ActionIcon
                            variant="subtle"
                            onClick={() => openShowcaseSection(showcase.id)}
                            aria-label={`Edit ${showcase.title}`}
                          >
                            <IconPencil size={16} />
                          </ActionIcon>
                        )}
                        <Switch
                          checked={s.enabled}
                          onChange={() => onToggleSection(s.key)}
                          labelPosition="left"
                          aria-label={label}
                          ml="auto"
                        />
                      </Group>
                    </Paper>
                  </SortableItem>
                );
              })}
            </Stack>
          </SortableContext>
        </DndContext>
        {features.profileShowcases && (
          <Button
            variant="light"
            leftSection={<IconPlus size={16} />}
            onClick={() => openShowcaseSection()}
            disabled={showcaseSections.length >= showcaseSectionLimits.sections}
          >
            Add showcase section ({showcaseSections.length}/{showcaseSectionLimits.sections})
          </Button>
        )}
      </Stack>
    </Input.Wrapper>
  );
};

export const InputProfileSectionsSettingsInput = withController(ProfileSectionsSettingsInput);
