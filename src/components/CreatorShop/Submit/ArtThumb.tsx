import { Center, LoadingOverlay } from '@mantine/core';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

// Shows the artwork the user selected — a local file preview (blob URL) while it
// hasn't been uploaded (incl. when it fails the checks) or the uploaded image.
export function ArtThumb({
  localUrl,
  imageId,
  uploading,
}: {
  localUrl: string | null;
  imageId: string | null;
  uploading?: boolean;
}) {
  return (
    <Center
      pos="relative"
      style={{
        width: 120,
        height: 120,
        background: 'var(--mantine-color-dark-8)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      <LoadingOverlay
        visible={!!uploading}
        loaderProps={{ size: 'sm' }}
        overlayProps={{ radius: 8, blur: 1 }}
      />
      {localUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={localUrl}
          alt="Selected artwork"
          style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
        />
      ) : imageId ? (
        <EdgeMedia
          src={imageId}
          width={120}
          alt="Artwork"
          className="max-h-full max-w-full object-contain"
        />
      ) : null}
    </Center>
  );
}
