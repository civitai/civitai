import { Alert, Center, Group, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import router from 'next/router';
import { CommentForm } from './CommentForm';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SimpleUser } from '~/server/selectors/user.selector';
import { useCommentsContext } from '~/components/CommentsV2/CommentsProvider';
import { IconLock } from '@tabler/icons';

type CreateCommentProps = {
  onCancel?: () => void;
  autoFocus?: boolean;
  replyTo?: SimpleUser;
};

export function CreateComment({ onCancel, autoFocus, replyTo }: CreateCommentProps) {
  const currentUser = useCurrentUser();
  const { isLocked, isMuted } = useCommentsContext();

  if (!currentUser)
    return (
      <Alert>
        <Group align="center" position="center" spacing="xs">
          <Text size="sm">
            You must{' '}
            <Text
              variant="link"
              component={NextLink}
              href={`/login?returnUrl=${router.asPath}`}
              inline
            >
              sign in
            </Text>{' '}
            to add a comment
          </Text>
        </Group>
      </Alert>
    );

  if (isLocked || isMuted)
    return (
      <Alert color="yellow" icon={<IconLock />}>
        <Center>
          {isMuted
            ? 'You cannot add comments because you have been muted'
            : 'This thread has been locked'}
        </Center>
      </Alert>
    );

  return (
    <Group align="flex-start" noWrap spacing="sm">
      <UserAvatar user={currentUser} size="md" />
      <CommentForm onCancel={onCancel} replyTo={replyTo} autoFocus={autoFocus} />
    </Group>
  );
}
