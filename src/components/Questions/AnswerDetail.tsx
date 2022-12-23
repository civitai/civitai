import { Group, Stack } from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { GetAnswersProps } from '~/server/controllers/answer.controller';
import { daysFromNow } from '~/utils/date-helpers';
import { useState } from 'react';
import { AnswerForm } from '~/components/Questions/AnswerForm';

export function AnswerDetail({
  answer,
  questionId,
}: {
  answer?: GetAnswersProps[0];
  questionId: number;
}) {
  const [editing, setEditing] = useState(false);

  if (!answer || editing) return <AnswerForm answer={answer} questionId={questionId} />;

  return (
    <Stack>
      <Group position="apart">
        <UserAvatar user={answer.user} subText={`${daysFromNow(answer.createdAt)}`} withUsername />
        {/* TODO - menu item for reporting */}
      </Group>
      <div>{answer.content}</div>
      {/* TODO - reactions */}
    </Stack>
  );
}
