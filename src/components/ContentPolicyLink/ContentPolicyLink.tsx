import type { AnchorProps } from '@mantine/core';
import { Anchor } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';

export function ContentPolicyLink(props: Props) {
  return (
    <Anchor
      {...props}
      component={Link}
      href="/safety#content-policies"
      target="_blank"
      rel="nofollow"
      span
    >
      Content Policies
    </Anchor>
  );
}

type Props = Omit<AnchorProps, 'children'>;
