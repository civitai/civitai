import React from 'react';
import type { SegmentedControlItem, SegmentedControlProps } from '@mantine/core';
import { SegmentedControl } from '@mantine/core';
import classes from './FeedContentToggle.module.scss';

const statuses: SegmentedControlItem[] = [
  { label: 'Published', value: 'published' },
  { label: 'Draft', value: 'draft' },
];

export function FeedContentToggle(props: Props) {
  return <SegmentedControl {...props} data={statuses} className={classes.feedContentToggle} />;
}

type Props = Omit<SegmentedControlProps, 'data'>;
