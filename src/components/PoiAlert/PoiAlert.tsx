import { IconExclamationMark } from '@tabler/icons-react';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { Anchor } from '@mantine/core';
import Link from 'next/link';

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
      <Link href="/content/rules/real-people" passHref>
        <Anchor span>Content Rules</Anchor>
      </Link>
      , only{' '}
      <Link href="/content/rules/real-people" passHref>
        <Anchor span>work-safe images</Anchor>
      </Link>{' '}
      and non-commercial use is permitted.
      <br />
      <br />
      If you are the person or a legal representative of the person depicted, and would like to
      request the removal of this {type === 'Bounty' ? 'bounty' : 'resource'}, you can do so{' '}
      <Link href="/content/rules/real-people" passHref>
        <Anchor span>here</Anchor>
      </Link>
      .
    </AlertWithIcon>
  );
}
