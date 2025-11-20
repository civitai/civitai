import type { ActionIconProps } from '@mantine/core';
import { ActionIcon, Loader, Menu } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import {
  IconBan,
  IconDotsVertical,
  IconFlag,
  IconPencil,
  IconRecycle,
  IconTrash,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/server/schema/report.schema';
import type { ArticleGetAllRecord } from '~/server/services/article.service';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { AddToCollectionMenuItem } from '~/components/MenuItems/AddToCollectionMenuItem';
import { ArticleStatus, CollectionType, CosmeticEntity } from '~/shared/utils/prisma/enums';
import React from 'react';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { ToggleLockComments } from '../CommentsV2/ToggleLockComments';
import { IconLock } from '@tabler/icons-react';
import { ToggleSearchableMenuItem } from '../MenuItems/ToggleSearchableMenuItem';
import { AddArtFrameMenuItem } from '~/components/Decorations/AddArtFrameMenuItem';
import type { ArticleGetById } from '~/types/router';
import { openAddToCollectionModal } from '~/components/Dialog/triggers/add-to-collection';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { createDialogTrigger } from '~/components/Dialog/dialogStore';

const ArticleUnpublishModal = dynamic(() => import('~/components/Modals/ArticleUnpublishModal'), {
  ssr: false,
});
const openArticleUnpublishModal = createDialogTrigger(ArticleUnpublishModal);

export function ArticleContextMenu({ article, ...props }: Props) {
  const queryUtils = trpc.useUtils();
  const router = useRouter();
  const currentUser = useCurrentUser();
  const isModerator = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === article.user?.id;

  const atDetailsPage = router.pathname === '/articles/[id]/[[...slug]]';
  const showUnpublish = atDetailsPage && article.status === ArticleStatus.Published;
  const showRestore =
    isModerator &&
    ((atDetailsPage && article.status === ArticleStatus.Unpublished) ||
      article.status === ArticleStatus.UnpublishedViolation);
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

  const unpublishArticleMutation = trpc.article.unpublish.useMutation();
  const handleUnpublishArticle = () => {
    unpublishArticleMutation.mutate(
      { id: article.id },
      {
        async onSuccess(result) {
          showSuccessNotification({
            title: 'Article unpublished',
            message: 'Successfully unpublished article',
          });

          queryUtils.article.getById.setData({ id: article.id }, (old) => ({
            ...(old as ArticleGetById),
            ...result,
          }));

          await queryUtils.article.getInfinite.invalidate();
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

  const restoreArticleMutation = trpc.article.restore.useMutation();
  const handleRestoreArticle = () => {
    restoreArticleMutation.mutate(
      { id: article.id },
      {
        async onSuccess(result) {
          showSuccessNotification({
            title: 'Article restored',
            message: 'Successfully restored article',
          });

          queryUtils.article.getById.setData({ id: article.id }, (old) => ({
            ...(old as ArticleGetById),
            ...result,
          }));

          await queryUtils.article.getInfinite.invalidate();
        },
        onError(error) {
          showErrorNotification({
            title: 'Failed to restore article',
            error: new Error(error.message),
          });
        },
      }
    );
  };

  return (
    <Menu position="left-start" withArrow offset={-5} withinPortal>
      <Menu.Target>
        <LegacyActionIcon
          {...props}
          color="gray.2"
          variant="transparent"
          p={0}
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <IconDotsVertical size={24} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {features.collections && (
          <AddToCollectionMenuItem
            key="add-to-collection"
            onClick={() =>
              openAddToCollectionModal({
                props: {
                  articleId: article.id,
                  type: CollectionType.Article,
                },
              })
            }
          />
        )}
        <ToggleSearchableMenuItem
          entityType="Article"
          entityId={article.id}
          key="toggle-searchable-menu-item"
        />
        {currentUser && (isOwner || isModerator) && (
          <>
            {isOwner && article.coverImage && !atDetailsPage && (
              <AddArtFrameMenuItem
                entityType={CosmeticEntity.Article}
                entityId={article.id}
                image={article.coverImage}
                currentCosmetic={article.cosmetic}
              />
            )}
            <Menu.Item
              color="red"
              leftSection={<IconTrash size={14} stroke={1.5} />}
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                handleDeleteArticle();
              }}
              disabled={deleteArticleMutation.isLoading}
            >
              Delete
            </Menu.Item>
            {showUnpublish && (
              <>
                {!isModerator && (
                  <Menu.Item
                    color="yellow"
                    leftSection={
                      unpublishArticleMutation.isLoading ? (
                        <Loader size={14} />
                      ) : (
                        <IconBan size={14} stroke={1.5} />
                      )
                    }
                    onClick={(e: React.MouseEvent) => {
                      e.preventDefault();
                      e.stopPropagation();
                      handleUnpublishArticle();
                    }}
                    disabled={unpublishArticleMutation.isLoading}
                    closeMenuOnClick={false}
                  >
                    Unpublish
                  </Menu.Item>
                )}
                {isModerator && (
                  <Menu.Item
                    color="yellow"
                    leftSection={<IconBan size={14} stroke={1.5} />}
                    onClick={(e: React.MouseEvent) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openArticleUnpublishModal({ props: { articleId: article.id } });
                    }}
                  >
                    Unpublish as Violation
                  </Menu.Item>
                )}
              </>
            )}
            {showRestore && (
              <Menu.Item
                color="green"
                leftSection={
                  restoreArticleMutation.isLoading ? (
                    <Loader size={14} />
                  ) : (
                    <IconRecycle size={14} stroke={1.5} />
                  )
                }
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  handleRestoreArticle();
                }}
                disabled={restoreArticleMutation.isLoading}
                closeMenuOnClick={false}
              >
                Restore
              </Menu.Item>
            )}
            <Menu.Item
              component={Link}
              href={`/articles/${article.id}/edit`}
              leftSection={<IconPencil size={14} stroke={1.5} />}
            >
              Edit
            </Menu.Item>
            {isModerator && (
              <ToggleLockComments entityId={article.id} entityType="article">
                {({ toggle, locked, isLoading }) => {
                  return (
                    <Menu.Item
                      leftSection={
                        isLoading ? <Loader size={14} /> : <IconLock size={14} stroke={1.5} />
                      }
                      onClick={toggle}
                      disabled={isLoading}
                      closeMenuOnClick={false}
                    >
                      {locked ? 'Unlock' : 'Lock'} Comments
                    </Menu.Item>
                  );
                }}
              </ToggleLockComments>
            )}
          </>
        )}
        {(!isOwner || isModerator) && (
          <LoginRedirect reason="report-article">
            <Menu.Item
              leftSection={<IconFlag size={14} stroke={1.5} />}
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                openReportModal({ entityType: ReportEntity.Article, entityId: article.id });
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
  article: Omit<ArticleGetAllRecord, 'stats'>;
};
