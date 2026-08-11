import { Badge, Button, Loader, Modal, Text } from '@mantine/core';
import { IconClockHour9 } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useMemo, useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore } from '~/components/Dialog/dialogStore';
import type { RecentSourceImage } from '~/store/recent-source-images.store';
import {
  dedupeSourceImages,
  recentSourceImagesStore,
  sourceImageKey,
  useRecentSourceImagesStore,
} from '~/store/recent-source-images.store';
import { refreshableBlobId } from '~/shared/orchestrator/blob-url';
import { almostEqual } from '~/utils/number-helpers';

type AspectRatio = `${number}:${number}`;

type BlobRefreshResult =
  | { blobId: string; status: 'refreshed'; url: string }
  | { blobId: string; status: 'gone' }
  | { blobId: string; status: 'unknown' };

export type RecentImagesPickerProps = {
  /** How many more images the input will accept. */
  remaining: number;
  aspectRatios?: AspectRatio[];
  /** Ratio every image is cropped to, for inputs using `cropToFirstImage`. */
  cropToRatio?: number;
  /** Set when picking for a named slot, so the header can say which one. */
  slotLabel?: string;
  /** Urls already in the input. Shown, but not selectable — re-adding one duplicates it. */
  existingUrls?: string[];
  onSelect: (images: RecentSourceImage[]) => void;
};

/**
 * Presigned URLs expire, so refresh the stale ones before showing them. A blob the
 * orchestrator reports as gone is dropped; anything else (offline, 5xx, blocked
 * request) leaves the entry alone — a failed refresh is not evidence it's gone.
 */
async function refreshExpired(images: RecentSourceImage[]) {
  const urlByBlobId = new Map<string, string>();
  for (const img of images) {
    const blobId = refreshableBlobId(img.url);
    if (blobId) urlByBlobId.set(blobId, img.url);
  }
  if (!urlByBlobId.size) return;

  const response = await fetch('/api/orchestrator/refreshBlobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blobIds: [...urlByBlobId.keys()] }),
  });
  if (!response.ok) return;

  const { results } = (await response.json()) as { results?: BlobRefreshResult[] };
  if (!Array.isArray(results)) return;

  const gone: string[] = [];
  for (const result of results) {
    const url = urlByBlobId.get(result.blobId);
    if (!url) continue;
    if (result.status === 'refreshed') recentSourceImagesStore.replaceUrl(url, result.url);
    else if (result.status === 'gone') gone.push(url);
  }
  recentSourceImagesStore.forget(gone);
}

function getWillCrop(image: RecentSourceImage, aspectRatios?: AspectRatio[], cropToRatio?: number) {
  const ratio = image.width / image.height;
  if (cropToRatio) return !almostEqual(cropToRatio, ratio, 0.01);
  if (!aspectRatios?.length) return false;
  return !aspectRatios.some((allowed) => {
    const [w, h] = allowed.split(':').map(Number);
    return almostEqual(w / h, ratio, 0.01);
  });
}

export function RecentImagesPicker({
  remaining,
  aspectRatios,
  cropToRatio,
  slotLabel,
  existingUrls,
  onSelect,
}: RecentImagesPickerProps) {
  const dialog = useDialogContext();
  const images = useRecentSourceImagesStore((state) => state.images);
  const [loading, setLoading] = useState(true);
  // Both keyed on sourceImageKey, not the url: the refresh below rewrites urls in
  // place, which would otherwise orphan every selection made while it was in flight.
  const [unavailable, setUnavailable] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string[]>([]);

  const multiSelect = remaining > 1;
  const alreadyAdded = useMemo(
    () => new Set((existingUrls ?? []).map(sourceImageKey)),
    [existingUrls]
  );

  useEffect(() => {
    let cancelled = false;
    refreshExpired(recentSourceImagesStore.getImages())
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectable = useMemo(
    () => dedupeSourceImages(images).filter((img) => !unavailable[sourceImageKey(img.url)]),
    [images, unavailable]
  );

  function commit(keys: string[]) {
    const picked = keys
      .map((key) => selectable.find((img) => sourceImageKey(img.url) === key))
      .filter((img): img is RecentSourceImage => !!img);
    if (picked.length) onSelect(picked);
    dialog.onClose();
  }

  function handleClick(image: RecentSourceImage) {
    const key = sourceImageKey(image.url);
    if (alreadyAdded.has(key)) return;
    if (!multiSelect) {
      commit([key]);
      return;
    }
    setSelected((prev) =>
      prev.includes(key)
        ? prev.filter((selectedKey) => selectedKey !== key)
        : prev.length < remaining
        ? [...prev, key]
        : prev
    );
  }

  const atCapacity = multiSelect && selected.length >= remaining;

  return (
    <Modal
      {...dialog}
      title={slotLabel ? `Recent images — ${slotLabel}` : 'Recent images'}
      size="lg"
    >
      <div className="flex flex-col gap-3">
        {multiSelect && (
          <Text size="xs" c="dimmed">
            {selected.length
              ? `Selected ${selected.length} of ${remaining} — added in the order you picked them`
              : `Select up to ${remaining} images — they're added in the order you pick them`}
            {atCapacity && ' · limit reached'}
          </Text>
        )}

        {loading && !images.length ? (
          <div className="flex justify-center py-10">
            <Loader size="sm" />
          </div>
        ) : !selectable.length ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <IconClockHour9 size={32} stroke={1.5} className="text-dimmed" />
            <Text size="sm" c="dimmed">
              No recent images yet
            </Text>
            <Text size="xs" c="dimmed">
              Images you upload or send to the generator will show up here.
            </Text>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {selectable.map((image) => {
              const key = sourceImageKey(image.url);
              const isAdded = alreadyAdded.has(key);
              const order = selected.indexOf(key);
              const isSelected = order > -1;
              const willCrop = !isAdded && getWillCrop(image, aspectRatios, cropToRatio);
              const disabled = isAdded || (multiSelect && atCapacity && !isSelected);
              return (
                <button
                  key={key}
                  type="button"
                  disabled={disabled}
                  aria-pressed={multiSelect ? isSelected : undefined}
                  onClick={() => handleClick(image)}
                  className={clsx(
                    'relative overflow-hidden rounded border-2 bg-gray-1 transition-colors dark:bg-dark-6',
                    isSelected
                      ? 'border-blue-5 ring-2 ring-blue-5/40'
                      : 'border-transparent hover:border-gray-4',
                    disabled && 'cursor-not-allowed opacity-40'
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={image.url}
                    alt=""
                    className={clsx(
                      'aspect-square w-full object-cover transition-opacity',
                      isSelected && 'opacity-60'
                    )}
                    onError={() => setUnavailable((prev) => ({ ...prev, [key]: true }))}
                  />
                  {isSelected && (
                    <span
                      className="absolute left-1 top-1 flex size-5 items-center justify-center rounded-full bg-blue-6 text-[11px] font-bold tabular-nums text-white shadow"
                      // The number IS the ordering contract — commit() adds them in
                      // selection order, which matters for slotted and reference inputs.
                      aria-label={`Selected, position ${order + 1}`}
                    >
                      {order + 1}
                    </span>
                  )}
                  <span className="absolute bottom-1 left-1 rounded bg-dark-9/70 px-1 text-[10px] tabular-nums text-white">
                    {image.width}×{image.height}
                  </span>
                  {isAdded && (
                    <Badge
                      size="xs"
                      variant="filled"
                      color="gray"
                      className="absolute right-1 top-1"
                    >
                      Added
                    </Badge>
                  )}
                  {willCrop && (
                    <Badge
                      size="xs"
                      variant="filled"
                      color="yellow"
                      className="absolute right-1 top-1"
                    >
                      Crops
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {!!selectable.length && (
          <div className="flex items-center justify-between gap-2">
            <Text
              component="button"
              type="button"
              size="xs"
              c="red"
              className="cursor-pointer border-0 bg-transparent p-0"
              onClick={() => recentSourceImagesStore.clear()}
            >
              Clear history
            </Text>
            {multiSelect && (
              <div className="flex gap-2">
                <Button variant="default" onClick={dialog.onClose}>
                  Cancel
                </Button>
                <Button disabled={!selected.length} onClick={() => commit(selected)}>
                  Add {selected.length || ''} {selected.length === 1 ? 'image' : 'images'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Entry point to the picker, sized for a field's label row alongside "Clear all".
 * The caller decides whether to render it — it needs to know anyway, so that the
 * label row isn't emitted for an action that would render nothing.
 */
export function RecentImagesButton(props: RecentImagesPickerProps) {
  return (
    <Text
      component="button"
      type="button"
      size="xs"
      c="blue"
      className="flex cursor-pointer items-center gap-1 whitespace-nowrap border-0 bg-transparent p-0"
      onClick={() => dialogStore.trigger({ component: RecentImagesPicker, props })}
    >
      <IconClockHour9 size={12} />
      Recent
    </Text>
  );
}
