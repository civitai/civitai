import { Container, Text } from '@mantine/core';
import Head from 'next/head';
import { casePublicRef } from '@civitai/moderation';
import { Meta } from '~/components/Meta/Meta';
import { CaseView } from '~/components/TakedownRequests/CaseView';
import { casePageProps, stripLinkTokenScript } from '~/components/TakedownRequests/case-link-token';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

type Props = { publicRef: string | null; open: boolean };

export const getServerSideProps = createServerSideProps<Props>({
  resolver: async ({ ctx, features }) => {
    // The page holds a private link: nothing it loads may learn its address.
    ctx.res.setHeader('Referrer-Policy', 'no-referrer');
    ctx.res.setHeader('Cache-Control', 'private, no-store');
    return {
      props: casePageProps(ctx.params?.publicRef, !!features?.takedownRequests, (v) =>
        casePublicRef.safeParse(v)
      ),
    };
  },
});

export default function CasePage({ publicRef, open }: Props) {
  return (
    <>
      <Meta title="Your request | Civitai" deIndex />
      <Head>
        <meta name="referrer" content="no-referrer" />
        {/* See stripLinkTokenScript: it must run before any other script, on every render of this page. */}
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: stripLinkTokenScript(publicRef, open) }}
        />
      </Head>
      <Container size="sm" py="xl">
        {publicRef && open ? (
          <CaseView publicRef={publicRef} />
        ) : (
          <Text>
            Your case can&apos;t be shown right now. To reach us about it, reply to the email we
            sent you, with your case number.
          </Text>
        )}
      </Container>
    </>
  );
}
