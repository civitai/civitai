import { ActionIcon, MantineNumberSize, Menu, MenuProps, Text } from '@mantine/core';
import { closeAllModals, closeModal, openConfirmModal } from '@mantine/modals';
import {
  IconBan,
  IconCalculator,
  IconCalculatorOff,
  IconDotsVertical,
  IconEdit,
  IconFlag,
  IconLock,
  IconLockOpen,
  IconSwitchHorizontal,
  IconTrash,
} from '@tabler/icons';
import { SessionUser } from 'next-auth';

import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { DeleteResourceReviewButton } from '~/components/ResourceReview/DeleteResourceReviewButton';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { closeRoutedContext, openRoutedContext } from '~/providers/RoutedContextProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { ReviewGetAllItem } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

export function ResourceReviewMenu({
  reviewId,
  userId,
  size = 'sm',
  review,
  ...props
}: {
  reviewId: number;
  userId: number;
  size?: MantineNumberSize;
  review: { id: number; rating: number; details?: string; modelId: number; modelVersionId: number };
} & MenuProps) {
  const currentUser = useCurrentUser();

  const isMod = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === userId;
  const isMuted = currentUser?.muted ?? false;

  // temp - remove when other controls are in place
  if (!isOwner && !isMod) return null;

  return (
    <Menu position="bottom-end" withinPortal {...props}>
      <Menu.Target>
        <ActionIcon size={size} variant="subtle">
          <IconDotsVertical size={16} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {(isOwner || isMod) && (
          <>
            <DeleteResourceReviewButton reviewId={reviewId}>
              {({ onClick }) => (
                <Menu.Item
                  icon={<IconTrash size={14} stroke={1.5} />}
                  color="red"
                  onClick={onClick}
                >
                  Delete review
                </Menu.Item>
              )}
            </DeleteResourceReviewButton>
            <Menu.Item
              icon={<IconEdit size={14} stroke={1.5} />}
              onClick={() => openContext('resourceReviewEdit', review)}
            >
              Edit review
            </Menu.Item>
            {/* {((!review.locked && !isMuted) || isMod) && (
              <Menu.Item
                icon={<IconEdit size={14} stroke={1.5} />}
                onClick={() => openRoutedContext('reviewEdit', { reviewId: review.id })}
              >
                Edit review
              </Menu.Item>
            )} */}
            {/* {isMod && !hideLockOption && (
              <Menu.Item
                icon={
                  review.locked ? (
                    <IconLockOpen size={14} stroke={1.5} />
                  ) : (
                    <IconLock size={14} stroke={1.5} />
                  )
                }
                onClick={handleToggleLockThread}
              >
                {review.locked ? 'Unlock review' : 'Lock review'}
              </Menu.Item>
            )} */}

            {/* {isMod && (
              <>
                <Menu.Item
                  icon={<IconSwitchHorizontal size={14} stroke={1.5} />}
                  onClick={handleConvertToComment}
                >
                  Convert to comment
                </Menu.Item>
                <Menu.Item icon={<IconBan size={14} stroke={1.5} />} onClick={handleTosViolation}>
                  Remove as TOS Violation
                </Menu.Item>
              </>
            )} */}
          </>
        )}
        {/* {(!currentUser || !isOwner) && (
          <LoginRedirect reason="report-model">
            <Menu.Item
              icon={<IconFlag size={14} stroke={1.5} />}
              onClick={() =>
                openContext('report', {
                  entityType: ReportEntity.ResourceReview,
                  entityId: reviewId,
                })
              }
            >
              Report
            </Menu.Item>
          </LoginRedirect>
        )} */}
      </Menu.Dropdown>
    </Menu>
  );
}
