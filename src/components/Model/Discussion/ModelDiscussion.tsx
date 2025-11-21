import { Button, Paper, ThemeIcon, Title, Text } from '@mantine/core';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { forwardRef } from 'react';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { IconClock, IconMessage, IconMessageCircleOff } from '@tabler/icons-react';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { JoinPopover } from '~/components/JoinPopover/JoinPopover';
import { ModelDiscussionV2 } from '~/components/Model/ModelDiscussion/ModelDiscussionV2';

type ModelDiscussionProps = {
  canDiscuss?: boolean;
  onlyEarlyAccess?: boolean;
  modelId: number;
  locked?: boolean;
};

export const ModelDiscussion = forwardRef<HTMLDivElement, ModelDiscussionProps>(
  ({ canDiscuss, onlyEarlyAccess, modelId, locked }, ref) => {
    const currentUser = useCurrentUser();
    const isMuted = currentUser?.muted ?? false;
    const showEarlyAccess = !isMuted && onlyEarlyAccess && !canDiscuss;
    const showAddComment = !isMuted && canDiscuss;
    return !locked ? (
      <div ref={ref} className="flex flex-col gap-4">
        <div className="flex gap-2.5">
          <Title order={2} data-tour="model:discussion">
            Discussion
          </Title>
          {showAddComment && (
            <LoginRedirect reason="create-comment">
              <Button
                leftSection={<IconMessage size={16} />}
                variant="outline"
                onClick={() => triggerRoutedDialog({ name: 'commentEdit', state: {} })}
                size="xs"
              >
                Add Comment
              </Button>
            </LoginRedirect>
          )}
          {showEarlyAccess && (
            <JoinPopover message="You must be a Civitai Member to join this discussion">
              <Button
                leftSection={<IconClock size={16} />}
                variant="outline"
                size="xs"
                color="green"
              >
                Early Access
              </Button>
            </JoinPopover>
          )}
        </div>
        <ModelDiscussionV2 modelId={modelId} />
      </div>
    ) : (
      <Paper p="lg" withBorder bg={`rgba(0, 0, 0, 0.1)`}>
        <div className="flex items-center justify-center gap-2.5">
          <ThemeIcon color="gray" size="xl" radius="xl">
            <IconMessageCircleOff />
          </ThemeIcon>
          <Text size="lg" c="dimmed">
            Discussion is turned off for this model.
          </Text>
        </div>
      </Paper>
    );
  }
);

ModelDiscussion.displayName = 'ModelDiscussion';
