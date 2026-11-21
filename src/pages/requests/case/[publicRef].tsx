import { Container } from '@mantine/core';
import Head from 'next/head';
import { casePublicRef } from '@civitai/moderation';
import { Meta } from '~/components/Meta/Meta';
import { CaseView } from '~/components/TakedownRequests/CaseView';
import { CASE_LINK_KEY } from '~/components/TakedownRequests/case-link-token';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps<{ publicRef: string }>({
  resolver: async ({ ctx, features }) => {
    const ref = casePublicRef.safeParse(ctx.params?.publicRef);
    if (!ref.success || !features?.takedownRequests) return { notFound: true };
    // The page holds a private link: nothing it loads may learn its address.
    ctx.res.setHeader('Referrer-Policy', 'no-referrer');
    ctx.res.setHeader('Cache-Control', 'private, no-store');
    return { props: { publicRef: ref.data } };
  },
});

const stripLinkToken = (publicRef: string) =>
  `(function(){var m=/[#&]t=([^&]+)/.exec(location.hash);if(!m)return;try{sessionStorage.setItem(${JSON.stringify(
    `${CASE_LINK_KEY}:${publicRef}`
  )},decodeURIComponent(m[1]))}catch(e){}history.replaceState(null,'',location.pathname)})();`;

export default function CasePage({ publicRef }: { publicRef: string }) {
  return (
    <>
      <Meta title="Your request | Civitai" deIndex />
      <Head>
        <meta name="referrer" content="no-referrer" />
        {/* Runs as the head parses, before any app or third-party script can read the address: takes
            the link token out of the URL and history, and leaves it in sessionStorage, which the case view empties as it reads it. */}
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: stripLinkToken(publicRef) }}
        />
      </Head>
      <Container size="sm" py="xl">
        <CaseView publicRef={publicRef} />
      </Container>
    </>
  );
}
