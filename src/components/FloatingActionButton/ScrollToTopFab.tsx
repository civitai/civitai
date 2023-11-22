import { IconArrowUp } from '@tabler/icons-react';
import React, { useState } from 'react';

import { FloatingActionButton } from './FloatingActionButton';
import { useScrollAreaNode } from '~/components/ScrollArea/ScrollArea';

type Props = Omit<
  React.ComponentProps<typeof FloatingActionButton>,
  'mounted' | 'onClick' | 'leftIcon' | 'children'
>;

export function ScrollToTopFab(props: Props) {
  const [show, setShow] = useState(false);
  const node = useScrollAreaNode({
    onScroll: () => {
      if (!node) return;
      setShow(node.scrollTop > 100);
    },
  });

  return (
    <FloatingActionButton
      mounted={show}
      onClick={() => node?.scrollTo({ top: 0, behavior: 'smooth' })}
      leftIcon={<IconArrowUp size={16} />}
      {...props}
    >
      Back to top
    </FloatingActionButton>
  );
}
