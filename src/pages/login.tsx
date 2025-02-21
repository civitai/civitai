import { Meta } from '~/components/Meta/Meta';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { TwCard } from '~/components/TwCard/TwCard';
import { LoginContent } from '~/components/Login/LoginContent';

export default function Login() {
  return (
    <>
      <Meta
        title="Sign in to Civitai"
        links={[{ href: `${env.NEXT_PUBLIC_BASE_URL}/login`, rel: 'canonical' }]}
      />
      <div className="container max-w-xs">
        <TwCard className="mt-6 border p-3 shadow">
          <LoginContent />
        </TwCard>
      </div>
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (session) {
      const { callbackUrl, error, reason } = ctx.query;
      if (reason !== 'switch-accounts') {
        const destinationURL = new URL(
          typeof callbackUrl === 'string' ? callbackUrl : '/',
          getBaseUrl()
        );
        if (error) destinationURL.searchParams.set('error', error as string);
        const destination = `${destinationURL.pathname}${destinationURL.search}${destinationURL.hash}`;

        return {
          redirect: {
            destination,
            permanent: false,
          },
        };
      }
    }

    return {
      props: { providers: null },
    };
  },
});
