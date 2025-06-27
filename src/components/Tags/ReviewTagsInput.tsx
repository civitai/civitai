import type { MultiSelectProps } from '@mantine/core';
import { useQueryTagsForReview } from '~/components/Tags/tag.utils';
import { MultiSelectWrapper } from '~/libs/form/components/MultiSelectWrapper';
import type { ModReviewType } from '~/server/common/enums';

export function ReviewTagsInput({
  reviewType,
  onChange,
  defaultValue: initialDefaultValue,
  ...selectProps
}: Props) {
  const { tags = [], isLoading } = useQueryTagsForReview({ reviewType });

  const handleChange = (value: string[]) => {
    // get tag ids from tags list based on value
    const tagIds = tags
      .filter((tag) => value.includes(tag.name))
      .map((tag) => tag.id)
      .filter((id): id is number => !!id);

    onChange?.(tagIds);
  };

  // Match the initialDefaultValue with the tags
  const defaultValue = initialDefaultValue
    ? tags.filter((tag) => initialDefaultValue.includes(tag.id)).map((tag) => tag.name)
    : [];

  return (
    <MultiSelectWrapper
      label="Tags"
      placeholder="Select tags"
      data={tags.map(({ name }) => name)}
      defaultValue={defaultValue}
      loading={isLoading}
      onChange={handleChange}
      nothingFoundMessage="No tags found"
      maxDropdownHeight={200}
      searchable={tags.length > 5}
      clearable
      {...selectProps}
    />
  );
}

type Props = Omit<MultiSelectProps, 'data' | 'onChange' | 'value' | 'defaultValue'> & {
  reviewType: ModReviewType;
  defaultValue?: number[];
  onChange?: (tagIds: number[]) => void;
};
