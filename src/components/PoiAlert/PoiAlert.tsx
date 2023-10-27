import { IconExclamationMark } from '@tabler/icons-react';
import { AlertWithIcon } from '../AlertWithIcon/AlertWithIcon';
import { Anchor } from '@mantine/core';
import Link from 'next/link';

type Props = Omit<React.ComponentProps<typeof AlertWithIcon>, 'icon' | 'children'>;

export function PoiAlert(alertProps: Props) {
  return (
    <AlertWithIcon {...alertProps} icon={<IconExclamationMark />}>
      This resource is intended to reproduce the likeness of a real person. Out of respect for this
      individual and in accordance with our{' '}
      <Link href="/content/rules/real-people" passHref>
        <Anchor span>Content Rules</Anchor>
      </Link>
      , only{' '}
      <Link href="/content/rules/real-people" passHref>
        <Anchor span>work-safe images</Anchor>
      </Link>{' '}
      and non-commercial use is permitted.
    </AlertWithIcon>
  );
}
