import { Container, Text } from '@mantine/core';
import Head from 'next/head';
import { casePublicRef } from '@civitai/moderation';
import { Meta } from '~/components/Meta/Meta';
import { CaseView } from '~/components/TakedownRequests/CaseView';
import { stripLinkTokenScript } from '~/components/TakedownRequests/case-link-token';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

type Props = { publicRef: string | null; open: boolean };

export const getServerSideProps = createServerSideProps<Props>({
  resolver: async ({ ctx, features }) => {
    // The page holds a private link: nothing it loads may learn its address.
    ctx.res.setHeader('Referrer-Policy', 'no-referrer');
    ctx.res.setHeader('Cache-Control', 'private, no-store');
    // Rendered even when it can't show a case (a bad reference, the forms switched off), never a 404,
    // so the head script below still takes the token out of the address.
    const ref = casePublicRef.safeParse(ctx.params?.publicRef);
    return {
      props: { publicRef: ref.success ? ref.data : null, open: !!features?.takedownRequests },
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
          dangerouslySetInnerHTML={{ __html: stripLinkTokenScript(publicRef) }}
        />
      </Head>
      <Container size="sm" py="xl">
        {publicRef && open ? (
          <CaseView publicRef={publicRef} />
        ) : (
          <Text>This page is not available. Use the latest link we emailed you.</Text>
        )}
      </Container>
    </>
  );
}
