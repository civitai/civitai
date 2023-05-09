import { ActionIcon, Menu } from '@mantine/core';
import { IconDotsVertical, IconFlag, IconPencil, IconTrash } from '@tabler/icons';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { SimpleUser } from '~/server/selectors/user.selector';

export function ArticleContextMenu({ article }: Props) {
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator;
  const isOwner = currentUser?.id === article.user?.id;

  return (
    <Menu>
      <Menu.Target>
        <ActionIcon
          variant="transparent"
          p={0}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <IconDotsVertical size={24} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {currentUser && isOwner && (
          <>
            <Menu.Item color="red" icon={<IconTrash size={14} stroke={1.5} />}>
              Delete
            </Menu.Item>
            <Menu.Item icon={<IconPencil size={14} stroke={1.5} />}>Edit</Menu.Item>
          </>
        )}
        {(!isOwner || isModerator) && (
          <LoginRedirect reason="report-article" key="report">
            <Menu.Item
              icon={<IconFlag size={14} stroke={1.5} />}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                openContext('report', { entityType: ReportEntity.Article, entityId: article.id });
              }}
            >
              Report article
            </Menu.Item>
          </LoginRedirect>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

type Props = { article: { id: number; user: SimpleUser } };
