import { useWindowScroll } from '@mantine/hooks';
import { IconArrowUp } from '@tabler/icons-react';
import React from 'react';

import { FloatingActionButton } from './FloatingActionButton';

type Props = Omit<
  React.ComponentProps<typeof FloatingActionButton>,
  'mounted' | 'onClick' | 'leftIcon' | 'children'
>;

export function ScrollToTopFab(props: Props) {
  const [scroll, scrollTo] = useWindowScroll();

  return (
    <FloatingActionButton
      mounted={scroll.y > 100}
      onClick={() => scrollTo({ y: 0 })}
      leftIcon={<IconArrowUp size={16} />}
      {...props}
    >
      Back to top
    </FloatingActionButton>
  );
}
