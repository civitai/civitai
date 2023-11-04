import { Card, Group, Input, InputWrapperProps, Paper, Stack, Switch, Text } from '@mantine/core';
import React, { useState } from 'react';
import { useDidUpdate } from '@mantine/hooks';
import { ProfileSectionSchema } from '~/server/schema/user-profile.schema';
import { IconArrowsMove, IconGripVertical } from '@tabler/icons-react';
import {
  getAllAvailableProfileSections,
  profileSectionLabels,
} from '~/components/Profile/profile.utils';
import {
  rectIntersection,
  DndContext,
  DragEndEvent,
  PointerSensor,
  UniqueIdentifier,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { isEqual } from 'lodash-es';

type ProfileSectionsSettingsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: ProfileSectionSchema[];
  onChange?: (value: ProfileSectionSchema[]) => void;
};

export const ProfileSectionsSettingsInput = ({
  value,
  onChange,
  ...props
}: ProfileSectionsSettingsInputProps) => {
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
      <Stack mt="md" spacing="xs">
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
                    sx={(theme) => ({
                      backgroundColor:
                        theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[1],
                    })}
                    withBorder
                    key={s.key}
                    p="xs"
                    radius="md"
                  >
                    <Group noWrap>
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
