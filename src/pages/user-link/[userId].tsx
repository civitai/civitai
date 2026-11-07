import type { GetServerSideProps } from 'next';
import { getUserCreator } from '~/server/services/user.service';

const MAX_USER_ID = 2147483647;

export const getServerSideProps: GetServerSideProps = async ({ params, res }) => {
  res.setHeader('X-Robots-Tag', 'noindex');

  const raw = String(params?.userId ?? '');
  const id = /^\d{1,10}$/.test(raw) ? Number(raw) : 0;
  if (!id || id > MAX_USER_ID) return { notFound: true };

  const user = await getUserCreator({ id });
  if (!user?.username || user.deletedAt) return { notFound: true };

  return {
    redirect: { destination: `/user/${encodeURIComponent(user.username)}`, permanent: false },
  };
};

export default function UserLinkPage() {
  return null;
}
