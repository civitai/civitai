import { cloneElement } from 'react';
import { useCommentsContext } from './CommentsProvider';

type Props = {
  children: ({ remaining }: { remaining: number }) => React.ReactElement;
};

export function LoadNextPage({ children }: Props) {
  const { data, count, isFetching, hasNextPage, fetchNextPage } = useCommentsContext();
  const remaining = count - (data?.length ?? 0);

  const handleClick = () => {
    if (!isFetching) fetchNextPage();
  };

  return hasNextPage && remaining > 0
    ? cloneElement(children({ remaining }), { onClick: handleClick })
    : null;
}
