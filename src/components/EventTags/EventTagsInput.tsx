import { Button, Group, Loader, TagsInput } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { eventTagSchema } from '~/server/schema/event-tag.schema';
import { MAX_EVENT_TAGS } from '~/shared/constants/event-tag.constants';
import { showErrorNotification } from '~/utils/notifications';

/**
 * A moderator's event tag list. Hands back only valid, normalised, de-duplicated tags, and refuses
 * the whole change (with a notification) if any tag is malformed. `quickTags` are one-click adds.
 */
export function EventTagsInput({
  value,
  onChange,
  loading,
  disabled,
  quickTags = [],
}: {
  value: string[];
  onChange: (eventTags: string[]) => void;
  loading?: boolean;
  disabled?: boolean;
  quickTags?: string[];
}) {
  const handleChange = (values: string[]) => {
    const parsed = values.map((v) => eventTagSchema.safeParse(v));
    const invalid = values.filter((_, i) => !parsed[i].success);
    if (invalid.length) {
      showErrorNotification({
        title: 'Invalid event tag',
        error: new Error(`Use letters, numbers and dashes: ${invalid.join(', ')}`),
      });
      return;
    }
    onChange([...new Set(parsed.flatMap((result) => (result.success ? [result.data] : [])))]);
  };
  const missingQuickTags = quickTags.filter((tag) => !value.includes(tag));

  return (
    <>
      <TagsInput
        aria-label="Event tags"
        placeholder="Add tag..."
        value={value}
        onChange={handleChange}
        maxTags={MAX_EVENT_TAGS}
        splitChars={[',', ' ']}
        acceptValueOnBlur
        disabled={disabled || loading}
        rightSection={loading ? <Loader size="xs" /> : undefined}
      />
      {missingQuickTags.length > 0 && (
        <Group gap={6} mt={6}>
          {missingQuickTags.map((tag) => (
            <Button
              key={tag}
              size="compact-xs"
              variant="light"
              radius="xl"
              leftSection={<IconPlus size={12} />}
              disabled={disabled || loading}
              onClick={() => handleChange([...value, tag])}
            >
              {tag}
            </Button>
          ))}
        </Group>
      )}
    </>
  );
}
