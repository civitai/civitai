import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { trpc } from '~/utils/trpc';

export function CommentsCount({
  entityType,
  entityId,
  initialCount,
  children,
}: CommentConnectorInput & {
  initialCount?: number;
  children: ({
    count,
    locked,
    isLoading,
  }: {
    count?: number;
    locked?: boolean;
    isLoading: boolean;
  }) => React.ReactNode;
}) {
  const { data: count, isLoading } = trpc.commentv2.getCount.useQuery(
    { entityId, entityType },
    { initialData: initialCount }
  );

  const { data: thread } = trpc.commentv2.getThreadDetails.useQuery({ entityId, entityType });

  return <>{children({ count, locked: thread?.locked, isLoading })}</>;
}
