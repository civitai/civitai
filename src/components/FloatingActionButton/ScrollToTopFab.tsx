import { IconArrowUp } from '@tabler/icons-react';
import React, { useState } from 'react';

import { FloatingActionButton } from './FloatingActionButton';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollArea';

type Props = Omit<
  React.ComponentProps<typeof FloatingActionButton>,
  'mounted' | 'onClick' | 'leftIcon' | 'children'
>;

export function ScrollToTopFab(props: Props) {
  const [show, setShow] = useState(false);
  const node = useScrollAreaRef({
    onScroll: () => {
      if (!node?.current) return;
      setShow(node.current.scrollTop > 100);
    },
  });

  return (
    <FloatingActionButton
      mounted={show}
      onClick={() => node?.current?.scrollTo({ top: 0, behavior: 'smooth' })}
      leftIcon={<IconArrowUp size={16} />}
      {...props}
    >
      Back to top
    </FloatingActionButton>
  );
}
