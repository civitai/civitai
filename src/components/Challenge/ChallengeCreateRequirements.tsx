import { Anchor, Divider, Paper, Stack, Text } from '@mantine/core';
import { IconCircleCheck, IconCircleX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { NextLink } from '~/components/NextLink/NextLink';
import type { RouterOutput } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';

type Eligibility = RouterOutput['challenge']['getCreateEligibility'];
type Requirement = Eligibility['requirements'][number];

function renderRequirement(req: Requirement): { title: string; content: ReactNode } {
  switch (req.key) {
    case 'score':
      return {
        title: `Have a creator score of at least ${abbreviateNumber(req.min)}`,
        content: (
          <Text size="sm" c="dimmed">
            Your current{' '}
            <Anchor component={NextLink} href="/user/account#creator-score" inherit>
              Creator Score
            </Anchor>{' '}
            is{' '}
            <Anchor component={NextLink} href="/user/account#creator-score" inherit>
              {abbreviateNumber(req.current)}
            </Anchor>
            .
          </Text>
        ),
      };
    case 'standing':
      return {
        title: 'Keep your account in good standing',
        content: (
          <Text size="sm" c="dimmed">
            {req.banned
              ? "Your account isn't eligible to create challenges."
              : req.muted
              ? "Muted accounts can't create challenges."
              : req.activeStrikes > 0
              ? `Resolve your ${req.activeStrikes} active strike${
                  req.activeStrikes === 1 ? '' : 's'
                } before creating a challenge.`
              : 'No active strikes or restrictions on your account.'}
          </Text>
        ),
      };
    case 'dailyLimit':
      return {
        title: 'Stay under the daily create limit',
        content: (
          <Text size="sm" c="dimmed">
            You&apos;ve created {req.recentCount} of {req.limit} challenges allowed in the last 24
            hours.
          </Text>
        ),
      };
    case 'activeLimit':
      return {
        title: 'Stay under your active challenge limit',
        content: (
          <Text size="sm" c="dimmed">
            You have {req.activeCount} of {req.limit} active challenge
            {req.limit === 1 ? '' : 's'} allowed for your membership tier.
          </Text>
        ),
      };
  }
}

function RequirementRow({ req }: { req: Requirement }) {
  const { title, content } = renderRequirement(req);
  return (
    <div className="flex gap-2">
      {req.met ? (
        <IconCircleCheck className="shrink-0 text-green-500" size={25} />
      ) : (
        <IconCircleX className="shrink-0 text-red-500" size={25} />
      )}
      <div className="flex flex-col gap-0">
        <Text className="font-bold">{title}</Text>
        {content}
      </div>
    </div>
  );
}

export function ChallengeCreateRequirements({ eligibility }: { eligibility: Eligibility }) {
  return (
    <Paper withBorder p="lg" radius="md">
      <Stack gap="md">
        <div>
          <Text fw={700} size="lg">
            Requirements to create a challenge
          </Text>
          <Text size="sm" c="dimmed">
            You don&apos;t meet all the requirements to create a challenge yet. Once every item below
            is met, you&apos;ll be able to create one.
          </Text>
        </div>
        <Divider />
        <Stack gap="md">
          {eligibility.requirements
            // The daily-create limit is an anti-spam throttle, not a standing entitlement — showing
            // "5/day allowed" beside the "1 active" cap reads as a contradiction. Only surface it
            // when it's the actual blocker.
            .filter((req) => !(req.key === 'dailyLimit' && req.met))
            .map((req) => (
              <RequirementRow key={req.key} req={req} />
            ))}
        </Stack>
      </Stack>
    </Paper>
  );
}
