import { IconExclamationMark } from '@tabler/icons-react';
import { Anchor, Text } from '@mantine/core';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { NextLink as Link } from '~/components/NextLink/NextLink';

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
      <Text size="sm" component="div">
        {openers[type]} Out of respect for this individual and in accordance with our{' '}
        <Anchor component={Link} href="/content/rules/real-people" inline inherit>
          Content Rules
        </Anchor>
        , only{' '}
        <Anchor component={Link} href="/content/rules/real-people" inline inherit>
          work-safe images
        </Anchor>{' '}
        and non-commercial use is permitted.
        <br />
        <br />
        <Text fw={500} component="strong" td="underline" inherit>
          If you are this person or a legal representative of this person
        </Text>
        , and would like to request the removal of this {type === 'Bounty' ? 'bounty' : 'resource'},
        you can do so{' '}
        <Anchor component={Link} href="/content/rules/real-people" inline inherit>
          here
        </Anchor>
        .
      </Text>
    </AlertWithIcon>
  );
}
