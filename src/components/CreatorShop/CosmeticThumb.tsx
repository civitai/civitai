import clsx from 'clsx';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

// Uniform artwork thumbnail — the raw cosmetic image contained in a fixed box.
// `bare` drops the framed box (border + background) for lists that want just the
// artwork. (CosmeticSample renders full previews/FeedCards that overflow a cell.)
export function CosmeticThumb({
  data,
  name,
  bare,
}: {
  data: unknown;
  name: string;
  bare?: boolean;
}) {
  const url = (data as { url?: string } | null)?.url;
  return (
    <div
      className={clsx(
        'flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md',
        !bare && 'border border-gray-3 bg-gray-0 dark:border-dark-4 dark:bg-dark-6'
      )}
    >
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
