import { GetServerSideProps } from 'next/types';
import { getServerProxySSGHelpers } from '~/server/utils/getServerProxySSGHelpers';
import { isNumber } from '~/utils/type-guards';
import { GalleryDetail } from '~/components/Gallery/GalleryDetail';

export default function GalleryImageDetail() {
  return <GalleryDetail />;
}

GalleryImageDetail.getLayout = (page: any) => <>{page}</>;

export const getServerSideProps: GetServerSideProps = async (context) => {
  const isClient = context.req.url?.startsWith('/_next/data');
  const params = (context.params ?? {}) as { galleryImageId: string };
  const id = Number(params.galleryImageId);
  if (!isNumber(id)) return { notFound: true };

  const ssg = await getServerProxySSGHelpers(context);
  if (!isClient) {
    await ssg.image.getGalleryImageDetail.prefetch({ id });
  }

  return {
    props: {
      trpcState: ssg.dehydrate(),
    },
  };
};
