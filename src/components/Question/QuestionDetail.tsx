import { Stack } from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { QuestionDetailProps } from '~/server/controllers/question.controller';
import { daysFromNow } from '~/utils/date-helpers';

export function QuestionDetail({ question }: { question: QuestionDetailProps }) {
  return (
    <Stack>
      <UserAvatar
        user={question.user}
        subText={`${daysFromNow(question.createdAt)}`}
        withUsername
      />
      <div>{question.content}</div>
      {/* TODO - reactions */}
      {/* TODO - comments */}
    </Stack>
  );
}
