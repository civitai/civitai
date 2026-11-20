import { Container } from '@mantine/core';
import Head from 'next/head';
import { casePublicRef } from '@civitai/moderation';
import { Meta } from '~/components/Meta/Meta';
import { CaseView } from '~/components/TakedownRequests/CaseView';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps<{ publicRef: string }>({
  resolver: async ({ ctx }) => {
    const ref = casePublicRef.safeParse(ctx.params?.publicRef);
    if (!ref.success) return { notFound: true };
    // The page holds a private link: nothing it loads may learn its address.
    ctx.res.setHeader('Referrer-Policy', 'no-referrer');
    ctx.res.setHeader('Cache-Control', 'private, no-store');
    return { props: { publicRef: ref.data } };
  },
});

export default function CasePage({ publicRef }: { publicRef: string }) {
  return (
    <>
      <Meta title="Your request | Civitai" deIndex />
      <Head>
        <meta name="referrer" content="no-referrer" />
      </Head>
      <Container size="sm" py="xl">
        <CaseView publicRef={publicRef} />
      </Container>
    </>
  );
}
