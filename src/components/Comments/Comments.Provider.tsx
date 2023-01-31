import {
  Stack,
  Text,
  Center,
  Loader,
  Group,
  Alert,
  GroupProps,
  ActionIcon,
  Anchor,
  Menu,
  StackProps,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconDotsVertical, IconTrash, IconEdit, IconFlag } from '@tabler/icons';
import { FetchNextPageOptions, InfiniteQueryObserverResult } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/router';
import React, { useState } from 'react';
import { createContext, useMemo } from 'react';
import { CommentForm } from '~/components/Comments/CommentForm';
import { DeleteComment } from '~/components/Comments/DeleteComment';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { openContext } from '~/providers/CustomModalsProvider';
import { InfiniteCommentResults } from '~/server/controllers/commentv2.controller';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { ReportEntity } from '~/server/schema/report.schema';
import { trpc } from '~/utils/trpc';

/*
  This comments component is designed to be modular and reusable. However there are a few things to remember when using this component.
    - initialData is data that should come from pre-fetching using ssr
      - prefetch up to {x} comments and set the initial count to {x - 1}
    - initialCount should come from pre-fetching, but it probably won't be an issue to fetch from the client if the need arises


  TODO -
  - determine different style presets that may be needed
  - determine how to best pass in special user/commenter labels (something flexible)
    - e.g: <Comments labels={{op: userId, modelCreator: userId, reviewCreator: userId}} />
*/

export type CommentsProps = {
  initialData?: InfiniteCommentResults['comments'];
  initialLimit?: number;
  initialCount?: number;
  children: React.ReactNode;
} & CommentConnectorInput;

type CommentsCtx = {
  data?: InfiniteCommentResults['comments'];
  loading?: boolean;
  count: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
  fetchNextPage: (
    options?: FetchNextPageOptions | undefined
  ) => Promise<InfiniteQueryObserverResult<InfiniteCommentResults>>;
} & CommentConnectorInput;

const CommentsCtx = createContext<CommentsCtx>({} as CommentsCtx);
export const useCommentsContext = () => {
  const context = React.useContext(CommentsCtx);
  if (!context) throw new Error('useCommentsContext can only be used inside CommentsCtx');
  return context;
};

export const Comments = ({
  children,
  entityId,
  entityType,
  initialData,
  initialLimit = 4,
  initialCount,
}: CommentsProps) => {
  const { items, nextCursor } = useMemo(() => {
    const data = [...(initialData ?? [])];
    return {
      nextCursor: data.length > initialLimit ? data.splice(-1)[0]?.id : undefined,
      items: data,
    };
  }, [initialData, initialLimit]);

  const { data, isInitialLoading, isFetching, fetchNextPage, hasNextPage } =
    trpc.commentv2.getInfinite.useInfiniteQuery(
      { entityId, entityType },
      {
        getNextPageParam: (lastPage) => {
          return !!lastPage ? lastPage.nextCursor : 0;
        },
        getPreviousPageParam: (firstPage) => {
          return !!firstPage ? firstPage.nextCursor : 0;
        },
        initialData: !!initialData
          ? {
              pages: [{ nextCursor, comments: items }],
              pageParams: [null],
            }
          : undefined,
      }
    );
  const { data: count = 0 } = trpc.commentv2.getCount.useQuery(
    { entityId, entityType },
    { initialData: initialCount }
  );

  const comments = useMemo(() => data?.pages.flatMap((x) => x.comments), [data]);

  return (
    <CommentsCtx.Provider
      value={{
        data: comments,
        loading: isFetching || isInitialLoading,
        entityId,
        entityType,
        count,
        hasNextPage,
        fetchNextPage,
      }}
    >
      {children}
    </CommentsCtx.Provider>
  );
};

Comments.List = function CommentsList({
  children,
  ...stackProps
}: {
  children: ({
    comment,
    index,
  }: {
    comment: InfiniteCommentResults['comments'][0];
    index: number;
  }) => React.ReactNode;
} & Omit<StackProps, 'children'>) {
  const { data, loading } = useCommentsContext();

  if (!data && loading)
    return (
      <Center p="xl">
        <Loader />
      </Center>
    );

  return !!data?.length ? (
    <Stack {...stackProps}>
      {data.map((comment, index) => (
        <React.Fragment key={comment.id}>{children({ comment, index })}</React.Fragment>
      ))}
    </Stack>
  ) : null;
};

Comments.ListItem = function CommentDetail({
  comment,
  ...groupProps
}: { comment: InfiniteCommentResults['comments'][0] } & GroupProps) {
  const { entityId, entityType } = useCommentsContext();
  const currentUser = useCurrentUser();
  const [editing, setEditing] = useState(false);
  const isOwner = currentUser?.id === comment.user.id;

  return (
    <Group align="flex-start" noWrap {...groupProps}>
      <UserAvatar user={comment.user} size="md" linkToProfile />
      <Stack spacing={0} style={{ flex: 1 }}>
        <Group position="apart">
          <Group spacing={8} align="center">
            <Link href={`/user/${comment.user.username}`} passHref>
              <Anchor variant="text" size="sm" weight="bold">
                {comment.user.username}
              </Anchor>
            </Link>
            <Text color="dimmed" size="xs">
              {<DaysFromNow date={comment.createdAt} />}
            </Text>
          </Group>
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon size="xs" variant="subtle">
                <IconDotsVertical size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {(isOwner || currentUser?.isModerator) && (
                <>
                  <DeleteComment id={comment.id} entityId={entityId} entityType={entityType}>
                    <Menu.Item icon={<IconTrash size={14} stroke={1.5} />} color="red">
                      Delete comment
                    </Menu.Item>
                  </DeleteComment>
                  <Menu.Item
                    icon={<IconEdit size={14} stroke={1.5} />}
                    onClick={() => setEditing(true)}
                  >
                    Edit comment
                  </Menu.Item>
                </>
              )}
              {(!currentUser || !isOwner) && (
                <LoginRedirect reason="report-model">
                  <Menu.Item
                    icon={<IconFlag size={14} stroke={1.5} />}
                    onClick={() =>
                      openContext('report', {
                        entityType: ReportEntity.Comment,
                        entityId: comment.id,
                      })
                    }
                  >
                    Report
                  </Menu.Item>
                </LoginRedirect>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
        <Stack style={{ flex: 1 }}>
          {editing ? (
            <CommentForm
              comment={comment}
              entityId={entityId}
              entityType={entityType}
              onCancel={() => setEditing(false)}
              autoFocus
            />
          ) : (
            <RenderHtml html={comment.content} sx={(theme) => ({ fontSize: theme.fontSizes.sm })} />
          )}
        </Stack>
      </Stack>
    </Group>
  );
};

Comments.More = function ShowMore({ ...props }: GroupProps) {
  const { data, count, loading, hasNextPage, fetchNextPage } = useCommentsContext();
  const showMoreCount = count - (data?.length ?? 0);

  const handleMoreClick = () => {
    if (!loading) fetchNextPage();
  };

  return hasNextPage ? (
    <Group spacing="xs" align="center" {...props}>
      {loading && <Loader size="xs" />}
      <Text variant="link" onClick={handleMoreClick} sx={{ cursor: 'pointer' }}>
        {showMoreCount > 0
          ? `Show ${showMoreCount} more ${showMoreCount > 1 ? 'comments' : 'comment'}`
          : 'Show more'}
      </Text>
    </Group>
  ) : null;
};

Comments.AddComment = function AddComment({ label = 'Add a comment' }: { label?: string }) {
  const user = useCurrentUser();
  const router = useRouter();
  const { entityId, entityType, hasNextPage } = useCommentsContext();
  const [initialHasNextPage] = useState(hasNextPage);
  const [creating, setCreating] = useState(!initialHasNextPage);

  if (hasNextPage) return null;

  return user ? (
    <Group align="flex-start" noWrap>
      <UserAvatar user={user} size="md" />
      <CommentForm
        entityId={entityId}
        entityType={entityType}
        // onCancel={initialHasNextPage ? () => setCreating(false) : undefined}
        // autoFocus={initialHasNextPage}
      />
    </Group>
  ) : (
    // !creating ? (
    //   <Text variant="link" onClick={() => setCreating(true)} sx={{ cursor: 'pointer' }}>
    //     {label}
    //   </Text>
    // ) : (
    //   <Group align="flex-start" noWrap>
    //     <UserAvatar user={user} size="md" />
    //     <CommentForm
    //       entityId={entityId}
    //       entityType={entityType}
    //       onCancel={initialHasNextPage ? () => setCreating(false) : undefined}
    //       autoFocus={initialHasNextPage}
    //     />
    //   </Group>
    // )
    <Alert>
      <Group align="center" position="center" spacing="xs">
        <Text size="sm">
          You must{' '}
          <Text variant="link" component={NextLink} href={`/login?returnUrl=${router.asPath}`}>
            sign in
          </Text>{' '}
          to add a comment
        </Text>
      </Group>
    </Alert>
  );
};
