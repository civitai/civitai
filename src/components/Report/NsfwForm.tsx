import React, { useMemo } from 'react';
import { createReportForm } from './create-report-form';
import { withWatcher } from '~/libs/form/hoc/withWatcher';
import { withController } from '~/libs/form/hoc/withController';
import { reportNsfwDetailsSchema } from '~/server/schema/report.schema';
import { Accordion, Badge, Chip, Group, Input, InputWrapperProps, Text } from '@mantine/core';
import { moderationCategories } from '~/libs/moderation';
import { InputTextArea } from '~/libs/form';

export const NsfwForm = createReportForm({
  schema: reportNsfwDetailsSchema,
  Element: () => {
    return (
      <>
        <InputModerationTags name="tags" label="Select all that apply" required />
        <InputTextArea name="comment" label="Comment (optional)" />
      </>
    );
  },
});

type ModerationTagsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: string[];
  onChange?: (value: string[]) => void;
};

function ModerationTagsInput({ value = [], onChange, ...props }: ModerationTagsInputProps) {
  value = Array.isArray(value) ? value : value ? [value] : [];

  const toggleTag = (tag: string) => {
    const updated = value.includes(tag) ? value.filter((x) => x !== tag) : [...value, tag];
    onChange?.(updated);
  };

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const category of moderationCategories) {
      counts[category.value] = 0;
      for (const child of category.children ?? [])
        if (value.includes(child.value)) counts[category.value] += 1;
    }
    return counts;
  }, [value]);

  return (
    <Input.Wrapper {...props}>
      <Accordion defaultValue={['suggestive', 'explicit nudity']} variant="contained" multiple>
        {moderationCategories
          .filter((x) => !!x.children?.length && !x.noInput)
          .map((category) => {
            const count = categoryCounts[category.value];
            return (
              <Accordion.Item key={category.value} value={category.value}>
                <Accordion.Control py="xs">
                  <Group position="apart">
                    <Text weight={500}>{category.label}</Text>
                    {count && <Badge>{count}</Badge>}
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Group spacing={5}>
                    {category.children
                      ?.filter((x) => !x.noInput)
                      .map((child) => (
                        <Chip
                          variant="filled"
                          radius="xs"
                          size="xs"
                          key={child.value}
                          onChange={() => toggleTag(child.value)}
                          checked={value.includes(child.value) ?? false}
                        >
                          {child.label}
                        </Chip>
                      ))}
                  </Group>
                </Accordion.Panel>
              </Accordion.Item>
            );
          })}
      </Accordion>
    </Input.Wrapper>
  );
}
const InputModerationTags = withWatcher(withController(ModerationTagsInput));
