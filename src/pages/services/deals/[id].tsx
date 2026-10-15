import { Container } from '@mantine/core';
import { useRouter } from 'next/router';
import { ServiceDealPage } from '~/components/CreatorShop/Services/deals/ServiceDealPage';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { resolveServiceDealPage } from '~/components/CreatorShop/Services/deals/deal-pages.server';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async (args) => resolveServiceDealPage(args),
});

export default function ServiceDealRoute() {
  const router = useRouter();
  const id = Number(router.query.id);
  return (
    <>
      <Meta title="Service deal" deIndex />
      <Container size="lg">
        <ServiceDealPage dealId={Number.isInteger(id) && id > 0 ? id : 0} />
      </Container>
    </>
  );
}
