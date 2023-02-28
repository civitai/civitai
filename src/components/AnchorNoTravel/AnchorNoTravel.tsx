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
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {props.children}
    </Anchor>
  );
};
