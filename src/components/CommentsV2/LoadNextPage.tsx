import { cloneElement } from 'react';
import { useCommentsContext } from './CommentsProvider';

type Props = {
  children: ({ remaining }: { remaining: number; onClick: () => void }) => React.ReactElement;
};

export function LoadNextPage({ children }: Props) {
  const { data, count, isFetching, hasNextPage, fetchNextPage, created } = useCommentsContext();
  const remaining = count - created.length - (data?.length ?? 0);

  const handleClick = () => {
    if (!isFetching) fetchNextPage();
  };

  return hasNextPage && remaining > 0
    ? cloneElement(children({ remaining, onClick: handleClick }))
    : null;
}
