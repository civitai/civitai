import { ActionIcon, Group, Menu, Stack, useMantineTheme } from '@mantine/core';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { GetAnswersProps } from '~/server/controllers/answer.controller';
import { daysFromNow } from '~/utils/date-helpers';
import { useState } from 'react';
import { AnswerForm } from '~/components/Questions/AnswerForm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { DeleteAnswer } from '~/components/Questions/DeleteAnswer';
import { IconDotsVertical, IconTrash, IconEdit } from '@tabler/icons';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';

export function AnswerDetail({
  answer,
  questionId,
}: {
  answer: GetAnswersProps[0];
  questionId: number;
}) {
  const theme = useMantineTheme();
  const user = useCurrentUser();
  const [editing, setEditing] = useState(false);

  const isModerator = user?.isModerator ?? false;
  const isOwner = user?.id === answer?.user.id;

  if (editing)
    return (
      <AnswerForm answer={answer} questionId={questionId} onCancel={() => setEditing(false)} />
    );

  return (
    <Stack>
      <Group position="apart">
        <UserAvatar user={answer.user} subText={`${daysFromNow(answer.createdAt)}`} withUsername />
        {/* TODO - menu item for reporting */}
        {(isOwner || isModerator) && (
          <Menu position="bottom-end" transition="pop-top-right">
            <Menu.Target>
              <ActionIcon variant="outline">
                <IconDotsVertical size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {(isOwner || isModerator) && (
                <>
                  <DeleteAnswer id={answer.id}>
                    <Menu.Item
                      color={theme.colors.red[6]}
                      icon={<IconTrash size={14} stroke={1.5} />}
                    >
                      Delete Question
                    </Menu.Item>
                  </DeleteAnswer>
                  <Menu.Item
                    icon={<IconEdit size={14} stroke={1.5} />}
                    onClick={() => setEditing(true)}
                  >
                    Edit question
                  </Menu.Item>
                </>
              )}
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
      <ReactionPicker reactions={[]} onSelect={(reaction) => {}} />
      <RenderHtml html={answer.content} />
      {/* TODO - reactions */}
    </Stack>
  );
}
