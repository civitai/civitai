import React from 'react';
import { SegmentedControl, SegmentedControlItem, SegmentedControlProps } from '@mantine/core';
import { containerQuery } from '~/utils/mantine-css-helpers';

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
        [containerQuery.smallerThan('sm')]: {
          width: '100%',
        },
      })}
    />
  );
}

type Props = Omit<SegmentedControlProps, 'data' | 'onChange'> & {
  onChange: (value: 'published' | 'draft') => void;
};
