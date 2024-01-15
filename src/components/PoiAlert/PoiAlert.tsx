import { IconExclamationMark } from '@tabler/icons-react';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { Anchor, Text } from '@mantine/core';
import Link from 'next/link';
import { NextLink } from '@mantine/next';

type AlertType = 'Bounty' | 'Model';
type Props = Omit<React.ComponentProps<typeof AlertWithIcon>, 'icon' | 'children'> & {
  type?: AlertType;
};

const openers: Record<AlertType, string> = {
  Bounty: 'This bounty is a request to reproduce the likeness of a real person.',
  Model: 'This resource is intended to reproduce the likeness of a real person.',
};

export function PoiAlert({ type = 'Model', ...alertProps }: Props) {
  return (
    <AlertWithIcon {...alertProps} icon={<IconExclamationMark />}>
      {openers[type]} Out of respect for this individual and in accordance with our{' '}
      <Text component={NextLink} href="/content/rules/real-people" variant="link">
        Content Rules
      </Text>
      , only{' '}
      <Text component={NextLink} href="/content/rules/real-people" variant="link">
        work-safe images
      </Text>{' '}
      and non-commercial use is permitted.
      <br />
      <br />
      <Text weight={500} component="strong" td="underline">
        If you are this person or a legal representative of this person
      </Text>
      , and would like to request the removal of this {type === 'Bounty' ? 'bounty' : 'resource'},
      you can do so{' '}
      <Text component={NextLink} href="/content/rules/real-people" variant="link">
        here
      </Text>
      .
    </AlertWithIcon>
  );
}
