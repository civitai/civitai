import { Stack } from '@mantine/core';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
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
      <RenderHtml html={question.content} />
      {/* TODO - reactions */}
    </Stack>
  );
}
