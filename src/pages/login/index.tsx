import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getBaseUrl } from '~/server/utils/url-helpers';
import { TwCard } from '~/components/TwCard/TwCard';
import { LoginContent } from '~/components/Login/LoginContent';
import { isDev } from '~/env/other';

export default function Login() {
  return (
    <>
      <Meta
        title="Sign in to Civitai"
        canonical="/login"
      />
      <div className="container max-w-xs">
        <TwCard className="mt-6 border p-3 shadow">
          <LoginContent />
        </TwCard>
      </div>
    </>
  );
}

function isSafeCrossOriginRedirect(url: string): boolean {
  try {
    return isDev || new URL(url).origin.includes('civitai');
  } catch {
    return false;
  }
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (session) {
      const { callbackUrl, returnUrl, error, reason } = ctx.query;
      if (reason !== 'switch-accounts') {
        const rawCallback =
          typeof returnUrl === 'string' ? returnUrl
          : typeof callbackUrl === 'string' ? callbackUrl
          : '/';
        // Prevent recursive login redirects
        const safeCallback = rawCallback.startsWith('/login') ? '/' : rawCallback;

        // Allow cross-domain redirects to known civitai domains
        if (isSafeCrossOriginRedirect(safeCallback)) {
          return {
            redirect: {
              destination: safeCallback,
              permanent: false,
            },
          };
        }

        const destinationURL = new URL(safeCallback, getBaseUrl());
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
