import { Container, Stack, Text, Title } from '@mantine/core';
import clsx from 'clsx';
import { BuzzTypeSelector } from '~/components/Buzz/BuzzPurchase/BuzzTypeSelector';
import { Meta } from '~/components/Meta/Meta';
import classes from '~/pages/pricing/index.module.scss';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

interface MembershipTypeSelectorProps {
  onSelect: (type: BuzzSpendType) => void;
}

export function MembershipTypeSelector({ onSelect }: MembershipTypeSelectorProps) {
  return (
    <BuzzTypeSelector
      title={null}
      description={null}
      onSelect={onSelect}
      greenButton={{
        text: 'Green Membership',
        description: (
          <>
            Membership benefits include <b>Green Buzz</b>.<br />
            Can <b>only</b> be used to generate <b>safe for work</b> content.
          </>
        ),
      }}
      yellowButton={{
        text: 'Yellow Membership',
        description: (
          <>
            Membership benefits include <b>Yellow Buzz</b>.<br />
            Can be used to generate <b>NSFW</b> content as well as anything else on the site.
          </>
        ),
      }}
    />
  );
}
