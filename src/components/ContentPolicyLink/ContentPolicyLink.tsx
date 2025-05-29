import type { AnchorProps } from '@mantine/core';
import { Anchor } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';

export function ContentPolicyLink(props: Props) {
  return (
    <Link legacyBehavior href="/safety#content-policies" passHref>
      <Anchor {...props} target="_blank" rel="nofollow" span>
        Content Policies
      </Anchor>
    </Link>
  );
}

type Props = Omit<AnchorProps, 'children'>;
