import { Badge, Checkbox, Group, Loader, Text } from '@mantine/core';
import { IconWand } from '@tabler/icons-react';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useRemixSubmitSelection } from '~/components/RemixGallery/remix-submit-selection.store';
import { Currency } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

/**
 * Why a source cannot be submitted to, in the poster's words rather than the
 * server's.
 *
 * `unavailable` deliberately says nothing about WHY the host cannot be shown.
 * The host's moderation state is not the poster's business, and this surface
 * would otherwise turn any image id into a way to read it — the same reason the
 * submit mutation's refusals are anonymised.
 */
const reasonLabel: Record<string, string> = {
  own: 'This is your own image',
  closed: 'Not available for this image',
  submitted: 'Already submitted',
  unavailable: 'Not available for this image',
};

/**
 * The galleries this image could be submitted to, as checkboxes, inside the post
 * editor's image card.
 *
 * Renders nothing when the image has no remix provenance, which is the ordinary
 * case: 0.2% of on-site generations carried any (measured 2026-08-27). A card
 * that always drew a header would put an empty section on almost every post.
 */
export function RemixSourcesCard({ imageId }: { imageId: number }) {
  const { data, isLoading } = trpc.placement.getRemixSourcesForImage.useQuery({ imageId });
  const selected = useRemixSubmitSelection((state) => state.selected[imageId] ?? []);
  const toggle = useRemixSubmitSelection((state) => state.toggle);

  if (isLoading) return null;
  if (!data?.length) return null;

  return (
    <div className="flex flex-col gap-2">
      <Group gap={6} wrap="nowrap">
        <IconWand size={18} className="shrink-0 text-yellow-6" />
        <h3 className="text-lg font-semibold leading-none text-dark-7 dark:text-gray-0">
          Submit this remix
        </h3>
      </Group>
      <Text size="xs" c="dimmed">
        {data.length === 1
          ? 'You made this from someone else’s image. Ask them to add it to their remix gallery.'
          : 'You made this from these images. Ask their creators to add it to their remix galleries.'}
      </Text>

      {data.map((source) => {
        const blocked = !!source.unavailable;
        const checked = selected.some((item) => item.hostImageId === source.hostImageId);

        return (
          <Group key={source.hostImageId} gap="sm" wrap="nowrap" align="center">
            <Checkbox
              checked={checked}
              disabled={blocked}
              onChange={(event) =>
                toggle(
                  imageId,
                  {
                    hostImageId: source.hostImageId,
                    // What is on screen right now. The mutation refuses a stale
                    // one rather than charging the new price silently.
                    expectedPrice: source.freeAvailable ? null : source.price ?? 0,
                    free: source.freeAvailable,
                  },
                  event.currentTarget.checked
                )
              }
              aria-label={`Submit to the gallery for image ${source.hostImageId}`}
            />
            {/* Links out rather than opening the detail dialog: this sits inside
                a post the poster is mid-way through editing, and a dialog over
                it invites them to navigate away from unsaved work. */}
            <Link
              href={`/images/${source.hostImageId}`}
              target="_blank"
              rel="noreferrer"
              className="shrink-0"
            >
              {source.url ? (
                <EdgeMedia
                  src={source.url}
                  type="image"
                  width={64}
                  className="size-12 rounded object-cover"
                  alt=""
                />
              ) : (
                <div className="size-12 rounded bg-gray-3 dark:bg-dark-5" />
              )}
            </Link>

            <div className="flex min-w-0 flex-col gap-1">
              {blocked ? (
                <Text size="sm" c="dimmed">
                  {reasonLabel[source.unavailable as string] ?? reasonLabel.unavailable}
                </Text>
              ) : source.freeAvailable ? (
                <Badge size="sm" variant="light" color="green" className="w-fit">
                  Free
                </Badge>
              ) : (
                <Group gap={4} wrap="nowrap">
                  <CurrencyIcon currency={Currency.BUZZ} size={14} />
                  <Text size="sm">{(source.price ?? 0).toLocaleString()}</Text>
                </Group>
              )}
              {/* Only for a remix we could not verify, and only when it costs
                  money — otherwise it is an unexplained absence of the word
                  "free" next to a price. Says what it is, not what is missing:
                  "unverified" reads as an accusation about a real remix. */}
              {!blocked && !source.freeAvailable && !source.verified && (
                <Text size="xs" c="dimmed">
                  Free submissions need a remix we can trace to the original
                </Text>
              )}
            </div>
          </Group>
        );
      })}
    </div>
  );
}

/** Shown while the query is in flight, where a caller wants a placeholder. */
export function RemixSourcesLoading() {
  return <Loader size="xs" />;
}
