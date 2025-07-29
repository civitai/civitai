import { Container, Stack, Text, Title } from '@mantine/core';
import clsx from 'clsx';
import { BuzzTypeSelector } from '~/components/Buzz/BuzzPurchase/BuzzTypeSelector';
import { Meta } from '~/components/Meta/Meta';
import classes from '~/pages/pricing/index.module.scss';
import type { BuzzSpendType } from '~/server/schema/buzz.schema';

interface MembershipTypeSelectorProps {
  onSelect: (type: BuzzSpendType) => void;
}

export function MembershipTypeSelector({ onSelect }: MembershipTypeSelectorProps) {
  return (
    <>
      <Meta
        title="Memberships | Civitai"
        description="As the leading generative AI community, we're adding new features every week. Help us keep the community thriving by becoming a Supporter and get exclusive perks."
      />
      <Container size="sm" mb="lg">
        <Stack>
          <Title className={clsx(classes.title, 'text-center')}>Choose Your Membership Type</Title>
          <Text align="center" className={classes.introText} style={{ lineHeight: 1.25 }}>
            Before selecting a membership plan, please choose which type of Buzz you&apos;d like to
            receive with your membership benefits.
          </Text>
        </Stack>
      </Container>
      <Container size="xl">
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
          redButton={{
            text: 'Red Membership',
            description: (
              <>
                Membership benefits include <b>Red Buzz</b>.<br />
                Can be used to generate <b>NSFW</b> content as well as anything else on the site.
              </>
            ),
          }}
        />
      </Container>
    </>
  );
}
