import { Button, Container, Text, Title } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import Link from 'next/link';
import { CRUCIBLE_JUDGE_MIN_CREATOR_SCORE } from '~/shared/constants/crucible.constants';
import { numberWithCommas } from '~/utils/number-helpers';

export function CrucibleJudgeScoreRequired({
  score,
  backHref,
}: {
  score?: number;
  backHref: string;
}) {
  return (
    <Container size="lg" className="py-16 text-center">
      <IconLock className="mx-auto mb-4 size-16 text-gray-500" />
      <Title order={2} mb="md">
        Judging needs a creator score of {numberWithCommas(CRUCIBLE_JUDGE_MIN_CREATOR_SCORE)}
      </Title>
      <Text c="dimmed" mb="xl" maw={480} className="mx-auto">
        {score !== undefined && <>Your creator score is {numberWithCommas(score)}. </>}
        It grows when people react to and comment on your images and articles, and when they follow
        you. Scores update once a day.
      </Text>
      <Button component={Link} href={backHref}>
        Back to Crucible
      </Button>
    </Container>
  );
}
