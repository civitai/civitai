import React from 'react';
import { SegmentedControl, SegmentedControlItem, SegmentedControlProps } from '@mantine/core';

const statuses: SegmentedControlItem[] = [
  { label: 'Published', value: 'published' },
  { label: 'Draft', value: 'draft' },
];

export function FeedContentToggle(props: Props) {
  return (
    <SegmentedControl
      {...props}
      data={statuses}
      sx={(theme) => ({
        [theme.fn.smallerThan('sm')]: {
          width: '100%',
        },
      })}
    />
  );
}

type Props = Omit<SegmentedControlProps, 'data' | 'onChange'> & {
  onChange: (value: 'published' | 'draft') => void;
};
