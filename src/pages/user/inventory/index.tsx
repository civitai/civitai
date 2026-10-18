import { enabledInventoryTypes } from '~/components/Inventory/inventory-types';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

export default function InventoryIndexPage() {
  return null;
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features, ctx }) => {
    if (!session?.user)
      return {
        redirect: { destination: getLoginLink({ returnUrl: ctx.resolvedUrl }), permanent: false },
      };
    const [first] = enabledInventoryTypes(features);
    if (!first) return { notFound: true };
    return { redirect: { destination: `/user/inventory/${first.key}`, permanent: false } };
  },
});
