import { Button, Divider, Modal, Stack, Text } from '@mantine/core';
import { IconArrowLeft, IconCircleCheck, IconCircleX } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { CreatorScoreGateMessage } from '~/components/CreatorJourney/CreatorScoreGateMessage';
import { useHasClientHistory } from '~/store/ClientHistoryStore';
import { describeActiveLimitsByTier } from '~/shared/constants/challenge.constants';
import { MUTE_POINTS } from '~/shared/constants/strike.constants';
import type { RouterOutput } from '~/types/router';
import { numberWithCommas } from '~/utils/number-helpers';

type Eligibility = RouterOutput['challenge']['getCreateEligibility'];
type Requirement = Eligibility['requirements'][number];

function renderRequirement(req: Requirement, noun: string): { title: string; content: ReactNode } {
  switch (req.key) {
    case 'score':
      return {
        title: `Have a Creator Score of at least ${numberWithCommas(req.min)}`,
        content: (
          <Text size="sm" c="dimmed">
            <CreatorScoreGateMessage score={req.current} required={req.min} />
          </Text>
        ),
      };
    case 'standing':
      return {
        title: 'Keep your account in good standing',
        content: (
          <Text size="sm" c="dimmed">
            {req.banned
              ? `Your account isn't eligible to create ${noun}s.`
              : req.muted
              ? `Muted accounts can't create ${noun}s.`
              : req.activePoints >= MUTE_POINTS
              ? `You can't create ${noun}s while your account has active strikes.`
              : 'No active strikes or restrictions on your account.'}
          </Text>
        ),
      };
    case 'dailyLimit':
      return {
        title: `Create at most ${req.limit} ${noun}s in any 24 hours`,
        content: (
          <Text size="sm" c="dimmed">
            You&apos;ve created {req.recentCount} in the last 24 hours.
          </Text>
        ),
      };
    case 'activeLimit':
      return {
        title: `Stay under your limit of ${noun}s running at once`,
        content: (
          <Text size="sm" c="dimmed">
            You have {req.activeCount} of {req.limit} running or scheduled. How many can run at once
            depends on membership: {describeActiveLimitsByTier()}.
          </Text>
        ),
      };
  }
}

function RequirementRow({ req, noun }: { req: Requirement; noun: string }) {
  const { title, content } = renderRequirement(req, noun);
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

export function ChallengeCreateRequirements({
  eligibility,
  noun = 'challenge',
  backUrl = '/challenges',
}: {
  eligibility: Eligibility;
  noun?: 'challenge' | 'crucible';
  backUrl?: string;
}) {
  const router = useRouter();
  const hasHistory = useHasClientHistory();

  const handleGoBack = () => {
    if (hasHistory) router.back();
    else router.push(backUrl);
  };

  return (
    <Modal
      opened
      onClose={handleGoBack}
      withCloseButton={false}
      closeOnClickOutside={false}
      closeOnEscape={false}
      title={`Requirements to create a ${noun}`}
      centered
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          You don&apos;t meet all the requirements to create a {noun} yet. Once every item below is
          met, you&apos;ll be able to create one.
        </Text>
        <Divider />
        <Stack gap="md">
          {eligibility.requirements
            // The daily-create limit is an anti-spam throttle, not a standing entitlement — showing
            // "5/day allowed" beside the "1 active" cap reads as a contradiction. Only surface it
            // when it's the actual blocker.
            .filter((req) => !(req.key === 'dailyLimit' && req.met))
            .map((req) => (
              <RequirementRow key={req.key} req={req} noun={noun} />
            ))}
        </Stack>
        <Button onClick={handleGoBack} leftSection={<IconArrowLeft size={16} />} fullWidth>
          Go back
        </Button>
      </Stack>
    </Modal>
  );
}
