import type { InputWrapperProps } from '@mantine/core';
import {
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
import type { ProfileSectionSchema } from '~/server/schema/user-profile.schema';
import { IconArrowsMove } from '@tabler/icons-react';
import {
  getAllAvailableProfileSections,
  profileSectionLabels,
} from '~/components/Profile/profile.utils';
import type { DragEndEvent, UniqueIdentifier } from '@dnd-kit/core';
import { rectIntersection, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { isEqual } from 'lodash-es';
import { withController } from '~/libs/form/hoc/withController';

type ProfileSectionsSettingsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: ProfileSectionSchema[];
  onChange?: (value: ProfileSectionSchema[]) => void;
};

export const ProfileSectionsSettingsInput = ({
  value,
  onChange,
  ...props
}: ProfileSectionsSettingsInputProps) => {
  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark');
  const [sections, setSections] = useState<ProfileSectionSchema[]>(
    getAllAvailableProfileSections(value || [])
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
      setSections(getAllAvailableProfileSections(value || []));
    }
  }, [value]);

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
        >
          <SortableContext
            items={sections.map((s) => s.key)}
            strategy={verticalListSortingStrategy}
          >
            <Stack>
              {sections.map((s) => (
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
                      <IconArrowsMove />
                      <Text size="sm">{profileSectionLabels[s.key]}</Text>
                      <Switch
                        checked={s.enabled}
                        onChange={() => onToggleSection(s.key)}
                        labelPosition="left"
                        aria-label={profileSectionLabels[s.key]}
                        ml="auto"
                      />
                    </Group>
                  </Paper>
                </SortableItem>
              ))}
            </Stack>
          </SortableContext>
        </DndContext>
      </Stack>
    </Input.Wrapper>
  );
};

export const InputProfileSectionsSettingsInput = withController(ProfileSectionsSettingsInput);
