import { Badge } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { TwCard } from '~/components/TwCard/TwCard';
import { trpc } from '~/utils/trpc';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RoutedDialogLink } from '~/components/Dialog/RoutedDialogLink';

export default function ImagesToIngest() {
  const { data, isLoading } = trpc.image.getAllImagesPendingIngestion.useQuery();

  return (
    <div className="container grid grid-cols-1 gap-2 @sm:grid-cols-2 @md:grid-cols-3 @lg:grid-cols-4">
      {data
        ?.sort((a, b) => a.id - b.id)
        .map((image) => (
          <TwCard key={image.id} className="border">
            <RoutedDialogLink
              name="imageDetail"
              state={{ imageId: image.id }}
              style={{
                aspectRatio:
                  ((image.metadata as any | null)?.width ?? 1) /
                  ((image.metadata as any | null)?.height ?? 1),
              }}
            >
              <EdgeMedia src={image.url} width={400} name={image.name} loading="lazy" />
            </RoutedDialogLink>
            <Badge className="absolute left-2 top-2" variant="filled">
              <DaysFromNow date={image.createdAt} />
            </Badge>
          </TwCard>
        ))}
    </div>
  );
}
