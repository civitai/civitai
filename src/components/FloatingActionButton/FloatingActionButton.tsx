import { Affix, Button, ButtonProps, Transition, TransitionProps } from '@mantine/core';

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
  return (
    <Affix position={{ bottom: 70, right: 20 }}>
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
