import React, { useMemo } from 'react';
import { createReportForm } from './create-report-form';
import { withWatcher } from '~/libs/form/hoc/withWatcher';
import { withController } from '~/libs/form/hoc/withController';
import { reportNsfwDetailsSchema } from '~/server/schema/report.schema';
import { Accordion, Badge, Chip, Group, Input, InputWrapperProps, Text } from '@mantine/core';
import { entityModerationCategories } from '~/libs/moderation';
import { InputTextArea } from '~/libs/form';
import { TagVotableEntityType } from '~/libs/tags';

export const ImageNsfwForm = createReportForm({
  schema: reportNsfwDetailsSchema,
  Element: () => {
    return (
      <>
        <InputModerationTags type="image" name="tags" label="Select all that apply" required />
        <InputTextArea name="comment" label="Comment (optional)" />
      </>
    );
  },
});

export const ModelNsfwForm = createReportForm({
  schema: reportNsfwDetailsSchema,
  Element: () => {
    return (
      <>
        <InputModerationTags type="model" name="tags" label="Select all that apply" required />
        <InputTextArea name="comment" label="Comment (optional)" />
      </>
    );
  },
});

type ModerationTagsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: string[];
  type: TagVotableEntityType;
  onChange?: (value: string[]) => void;
};

const defaultAccordions: Record<TagVotableEntityType, string[]> = {
  model: ['explicit nudity'],
  image: ['suggestive', 'explicit nudity'],
};
function ModerationTagsInput({ value = [], onChange, type, ...props }: ModerationTagsInputProps) {
  value = Array.isArray(value) ? value : value ? [value] : [];

  const toggleTag = (tag: string) => {
    const updated = value.includes(tag) ? value.filter((x) => x !== tag) : [...value, tag];
    onChange?.(updated);
  };

  const moderationCategories = useMemo(() => entityModerationCategories[type], [type]);

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
      <Accordion defaultValue={defaultAccordions[type]} variant="contained" multiple>
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
