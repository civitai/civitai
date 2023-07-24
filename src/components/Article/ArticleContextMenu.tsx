import { ActionIcon, ActionIconProps, Menu } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { NextLink } from '@mantine/next';
import { IconBan, IconDotsVertical, IconFlag, IconPencil, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { ArticleGetAll } from '~/types/router';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { AddToCollectionMenuItem } from '~/components/MenuItems/AddToCollectionMenuItem';
import { CollectionType } from '@prisma/client';
import React from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export function ArticleContextMenu({ article, withinPortal = true, ...props }: Props) {
  const queryUtils = trpc.useContext();
  const router = useRouter();
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === article.user?.id;

  const atDetailsPage = router.pathname === '/articles/[id]/[[...slug]]';
  const showUnpublish = atDetailsPage && article.publishedAt !== null;
  const features = useFeatureFlags();

  const deleteArticleMutation = trpc.article.delete.useMutation();
  const handleDeleteArticle = () => {
    openConfirmModal({
      title: 'Delete article',
      children:
        'Are you sure you want to delete this article? This action is destructive and cannot be reverted.',
      labels: { cancel: "No, don't delete it", confirm: 'Delete article' },
      confirmProps: { color: 'red' },
      onConfirm: () =>
        deleteArticleMutation.mutate(
          { id: article.id },
          {
            async onSuccess() {
              showSuccessNotification({
                title: 'Article deleted',
                message: 'Successfully deleted article',
              });

              if (atDetailsPage) await router.push('/articles');
              await queryUtils.article.getInfinite.invalidate();
              await queryUtils.article.getByCategory.invalidate();
            },
            onError(error) {
              showErrorNotification({
                title: 'Failed to delete article',
                error: new Error(error.message),
              });
            },
          }
        ),
    });
  };

  const upsertArticleMutation = trpc.article.upsert.useMutation();
  const handleUnpublishArticle = () => {
    upsertArticleMutation.mutate(
      { ...article, publishedAt: null },
      {
        async onSuccess(result) {
          showSuccessNotification({
            title: 'Article unpublished',
            message: 'Successfully unpublished article',
          });

          await queryUtils.article.getById.invalidate({ id: result.id });
          await queryUtils.article.getInfinite.invalidate();
          await queryUtils.article.getByCategory.invalidate();
          await queryUtils.article.getMyDraftArticles.invalidate();
        },
        onError(error) {
          showErrorNotification({
            title: 'Failed to unpublish article',
            error: new Error(error.message),
          });
        },
      }
    );
  };

  return (
    <Menu position="left-start" withArrow offset={-5} withinPortal={withinPortal}>
      <Menu.Target>
        <ActionIcon
          {...props}
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
        {features.collections && (
          <AddToCollectionMenuItem
            key="add-to-collection"
            onClick={() =>
              openContext('addToCollection', {
                articleId: article.id,
                type: CollectionType.Article,
              })
            }
          />
        )}
        {currentUser && (isOwner || isModerator) && (
          <>
            <Menu.Item
              color="red"
              icon={<IconTrash size={14} stroke={1.5} />}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleDeleteArticle();
              }}
              disabled={deleteArticleMutation.isLoading}
            >
              Delete
            </Menu.Item>
            {showUnpublish && (
              <Menu.Item
                color="yellow"
                icon={<IconBan size={14} stroke={1.5} />}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleUnpublishArticle();
                }}
                disabled={upsertArticleMutation.isLoading}
              >
                Unpublish
              </Menu.Item>
            )}
            <Menu.Item
              component={NextLink}
              href={`/articles/${article.id}/edit`}
              icon={<IconPencil size={14} stroke={1.5} />}
            >
              Edit
            </Menu.Item>
          </>
        )}
        {(!isOwner || isModerator) && (
          <LoginRedirect reason="report-article">
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

type Props = Omit<ActionIconProps, 'variant' | 'onClick'> & {
  article: Omit<ArticleGetAll['items'][number], 'stats'>;
  withinPortal?: boolean;
};
