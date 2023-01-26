import { useRouter } from 'next/router';
import { useGalleryFilters } from '~/components/Gallery/GalleryFilters';
import { GalleryItem } from '~/components/Gallery/GalleryItem';
import { trpc } from '~/utils/trpc';

export function GalleryItemFinite() {
  const router = useRouter();
  const id = Number(router.query.galleryImageId);
  const filters = useGalleryFilters();
  const { data = [], isLoading } = trpc.image.getGalleryImages.useQuery({ ...filters });
  // disabled since the only time we care about this value is when using ssr prefetch
  const { data: prefetchedImage } = trpc.image.getGalleryImageDetail.useQuery(
    { id },
    { enabled: false }
  );

  const image = data?.find((x) => x.id === id) ?? prefetchedImage ?? undefined;

  return <GalleryItem current={image} images={data} loading={isLoading} withIndicators />;
}
