import { Anchor, AnchorProps } from '@mantine/core';
import Link from 'next/link';

export function ContentPolicyLink(props: Props) {
  return (
    <Link href="/safety#content-policies" passHref>
      <Anchor {...props} target="_blank" rel="nofollow" span>
        Content Policies
      </Anchor>
    </Link>
  );
}

type Props = Omit<AnchorProps, 'children'>;
