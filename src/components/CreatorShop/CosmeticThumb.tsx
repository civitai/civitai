import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

// Uniform artwork thumbnail — the raw cosmetic image contained in a fixed box.
// (CosmeticSample renders full previews/FeedCards that overflow a table cell.)
export function CosmeticThumb({ data, name }: { data: unknown; name: string }) {
  const url = (data as { url?: string } | null)?.url;
  return (
    <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md border border-gray-3 bg-gray-0 dark:border-dark-4 dark:bg-dark-6">
      {url ? (
        <EdgeMedia
          src={url}
          width={44}
          alt={name}
          className="h-auto max-h-full w-auto max-w-full object-contain"
        />
      ) : null}
    </div>
  );
}
