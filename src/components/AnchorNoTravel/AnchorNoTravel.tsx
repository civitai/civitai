import { Anchor, AnchorProps } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { NextLinkProps } from '@mantine/next/lib/NextLink';

export const AnchorNoTravel = (props: NextLinkProps & AnchorProps) => {
  return (
    <Anchor
      variant="text"
      component={NextLink}
      {...props}
      onClick={(e) => {
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
