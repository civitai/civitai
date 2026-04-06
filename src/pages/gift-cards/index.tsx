import type { GetServerSideProps } from 'next';

export const getServerSideProps: GetServerSideProps = async () => {
  return {
    redirect: {
      destination: '/purchase/buzz',
      permanent: false,
    },
  };
};

export default function GiftCardsPage() {
  return null;
}
