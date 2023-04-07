import { Anchor, AnchorProps } from '@mantine/core';
import Link from 'next/link';
import { ComponentProps } from 'react';

type NextLinkProps = ComponentProps<typeof Link>;

export const AnchorNoTravel = (props: NextLinkProps & AnchorProps) => {
  return (
    <Anchor
      variant="text"
      component={Link}
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
