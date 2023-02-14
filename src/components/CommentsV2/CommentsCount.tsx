import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { trpc } from '~/utils/trpc';

export function CommentsCount({
  entityType,
  entityId,
  initialCount,
  children,
}: CommentConnectorInput & {
  initialCount?: number;
  children: ({ count }: { count: number }) => React.ReactNode;
}) {
  const { data: count = 0 } = trpc.commentv2.getCount.useQuery(
    { entityId, entityType },
    { initialData: initialCount }
  );

  return <>{children({ count })}</>;
}
