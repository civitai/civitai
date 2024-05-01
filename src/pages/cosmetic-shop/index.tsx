import { PageLoader } from '~/components/PageLoader/PageLoader';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  resolver: async () => {
    return {
      redirect: {
        destination: '/shop',
        permanent: true,
      },
    };
  },
});

export default function CosmeticShopMain() {
  return <PageLoader text="Redirecting to cosmetic shop..." />;
}
