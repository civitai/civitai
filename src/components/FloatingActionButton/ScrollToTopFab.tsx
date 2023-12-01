import { IconArrowUp } from '@tabler/icons-react';
import React, { useState } from 'react';

import { FloatingActionButton, FloatingActionButton2 } from './FloatingActionButton';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollArea';
import { Button } from '@mantine/core';

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
    <FloatingActionButton2 mounted={show} {...props}>
      <Button
        leftIcon={<IconArrowUp size={16} />}
        onClick={() => node?.current?.scrollTo({ top: 0, behavior: 'smooth' })}
      >
        Back to top
      </Button>
    </FloatingActionButton2>
  );
}
