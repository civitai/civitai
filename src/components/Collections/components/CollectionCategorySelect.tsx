import { Select, SelectProps } from '@mantine/core';
import { useState } from 'react';
import { useCollection } from '~/components/Collections/collection.utils';

// eslint-disable-next-line @typescript-eslint/ban-types
type Value = 'all' | (string & {});

export function CollectionCategorySelect({ collectionId, value, onChange, ...selectProps }: Props) {
  const [innerValue, setInnerValue] = useState<Value | null>(value ?? null);
  const { collection, isLoading } = useCollection(collectionId);

  const handleChange = (value: string | null) => {
    setInnerValue(value);
    onChange?.(value);
  };

  return (
    <Select
      value={innerValue}
      onChange={handleChange}
      nothingFoundMessage={isLoading ? 'Loading...' : 'No categories found'}
      label="Collection Categories"
      placeholder="All"
      data={
        collection
          ? [
              { value: 'all', label: 'All' },
              ...collection.tags?.map((tag) => ({
                value: tag.id.toString(),
                label: tag.name.toUpperCase(),
              })),
            ]
          : []
      }
      clearable
      {...selectProps}
    />
  );
}

type Props = Omit<SelectProps, 'data' | 'value' | 'onChange'> & {
  collectionId: number;
  value?: Value | null;
  onChange?: (value: Value | null) => void;
};
