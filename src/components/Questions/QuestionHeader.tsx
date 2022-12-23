import { ActionIcon, Badge, Group, Menu, Stack, Title, useMantineTheme } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconDotsVertical, IconEdit, IconTrash } from '@tabler/icons';

import { DeleteQuestion } from '~/components/Questions/DeleteQuestion';
import { useCurrentUser } from '~/hooks/useCurrentUser';

import { QuestionDetailProps } from '~/server/controllers/question.controller';

export function QuestionHeader({ question }: { question: QuestionDetailProps }) {
  const user = useCurrentUser();
  const theme = useMantineTheme();

  const isModerator = user?.isModerator ?? false;
  const isOwner = user?.id === question?.user.id;

  return (
    <Group position="apart" noWrap>
      <Stack>
        <Title>{question.title}</Title>
        <Group spacing={4}>
          {question.tags.map((tag) => (
            <Badge
              key={tag.id}
              color="blue"
              component="a"
              size="sm"
              radius="sm"
              // sx={{ cursor: 'pointer' }}
            >
              {tag.name}
            </Badge>
          ))}
        </Group>
      </Stack>
      {/* TODO - add additional actions and remove condition here */}
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
                <DeleteQuestion id={question.id}>
                  <Menu.Item
                    color={theme.colors.red[6]}
                    icon={<IconTrash size={14} stroke={1.5} />}
                  >
                    Delete Question
                  </Menu.Item>
                </DeleteQuestion>
                <Menu.Item
                  component={NextLink}
                  href={`/questions/${question.id}/${question.title}?edit=true`}
                  icon={<IconEdit size={14} stroke={1.5} />}
                  shallow
                >
                  Edit question
                </Menu.Item>
              </>
            )}
          </Menu.Dropdown>
        </Menu>
      )}
    </Group>
  );
}
