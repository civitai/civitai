import { Anchor, AnchorProps } from '@mantine/core';
import { type NextLinkProps, NextLink as Link } from '~/components/NextLink/NextLink';

export const AnchorNoTravel = (props: NextLinkProps & AnchorProps) => {
  return (
    <Anchor
      variant="text"
      component={Link}
      {...props}
      onClick={(e: React.MouseEvent) => {
        if (e.target !== e.currentTarget) {
          const target = e.target as HTMLAnchorElement;
          if (target.tagName === 'A') {
            window.open(target.href, target.target ?? '_blank');
          }
        }
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {props.children}
    </Anchor>
  );
};
