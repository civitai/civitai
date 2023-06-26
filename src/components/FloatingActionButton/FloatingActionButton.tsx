import { Affix, Button, ButtonProps, Transition, TransitionProps } from '@mantine/core';
import { useDebouncedState, useWindowEvent } from '@mantine/hooks';
import { getScrollPosition } from '~/utils/window-helpers';

type Props = Omit<ButtonProps, 'style' | 'onClick'> &
  Pick<TransitionProps, 'transition' | 'mounted' | 'duration'> & {
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  };

export function FloatingActionButton({
  transition,
  mounted,
  children,
  duration,
  ...buttonProps
}: Props) {
  const [hasFooter, setHasFooter] = useDebouncedState(true, 200);

  useWindowEvent('scroll', () => {
    const scroll = getScrollPosition();
    setHasFooter(scroll.y < 10);
  });

  return (
    <Affix
      position={{ bottom: hasFooter ? 70 : 12, right: 12 }}
      style={{ transition: 'bottom 300ms linear' }}
    >
      <Transition transition={transition} mounted={mounted} duration={duration}>
        {(transitionStyles) => (
          <Button {...buttonProps} style={transitionStyles}>
            {children}
          </Button>
        )}
      </Transition>
    </Affix>
  );
}
