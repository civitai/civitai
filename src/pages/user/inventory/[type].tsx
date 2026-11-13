import { InventoryLayout } from '~/components/Inventory/InventoryLayout';
import { enabledInventoryTypes } from '~/components/Inventory/inventory-types';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

export default function InventoryTypePage({ type }: { type: string }) {
  return <InventoryLayout typeKey={type} />;
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features, ctx }) => {
    if (!session?.user)
      return {
        redirect: { destination: getLoginLink({ returnUrl: ctx.resolvedUrl }), permanent: false },
      };
    const type = ctx.params?.type;
    if (typeof type !== 'string' || !enabledInventoryTypes(features).some((t) => t.key === type))
      return { notFound: true };
    return { props: { type } };
  },
});
