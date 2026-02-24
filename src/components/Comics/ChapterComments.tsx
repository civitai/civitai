import { Button, Textarea } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import Link from 'next/link';
import { useState } from 'react';

import { UserAvatarSimple } from '~/components/UserAvatar/UserAvatarSimple';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { formatRelativeDate } from '~/utils/comic-helpers';
import { trpc } from '~/utils/trpc';

export function ChapterComments({
  projectId,
  chapterPosition,
}: {
  projectId: number;
  chapterPosition: number;
}) {
  const currentUser = useCurrentUser();
  const [comment, setComment] = useState('');

  const { data: thread, isLoading } = trpc.comics.getChapterThread.useQuery(
    { projectId, chapterPosition },
    { enabled: projectId > 0 }
  );

  const utils = trpc.useUtils();
  const createComment = trpc.comics.createChapterComment.useMutation({
    onSuccess: () => {
      setComment('');
      utils.comics.getChapterThread.invalidate({ projectId, chapterPosition });
    },
  });

  const handleSubmit = () => {
    if (!comment.trim()) return;
    createComment.mutate({ projectId, chapterPosition, content: comment.trim() });
  };

  return (
    <div>
      <h3 className="text-base font-medium mb-3">
        Comments {thread?.commentCount ? `(${thread.commentCount})` : ''}
      </h3>

      {/* Comment input */}
      {currentUser ? (
        <div className="flex gap-2 mb-4">
          <Textarea
            placeholder="Write a comment..."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="flex-1"
            size="sm"
            autosize
            maxRows={4}
          />
          <Button
            onClick={handleSubmit}
            loading={createComment.isPending}
            disabled={!comment.trim()}
            size="sm"
            variant="filled"
          >
            <IconSend size={16} />
          </Button>
        </div>
      ) : (
        <p className="text-sm text-gray-400 mb-4">
          <Link href="/login" className="text-blue-400 hover:underline">
            Sign in
          </Link>{' '}
          to leave a comment.
        </p>
      )}

      {/* Comment list */}
      {isLoading ? (
        <div className="text-sm text-gray-400">Loading comments...</div>
      ) : !thread?.comments?.length ? (
        <div className="text-sm text-gray-400">No comments yet. Be the first!</div>
      ) : (
        <div className="flex flex-col gap-3">
          {thread.comments.map((c) => (
            <div key={c.id} className="flex gap-2">
              <UserAvatarSimple {...c.user} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium">{c.user.username}</span>
                  <span className="text-xs text-gray-400">{formatRelativeDate(c.createdAt)}</span>
                </div>
                <p className="text-sm mt-0.5 whitespace-pre-wrap break-words">{c.content}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
