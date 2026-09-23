import { Badge, Group, Stack, Text } from '@mantine/core';
import type {
  CreatePostConsentCopy,
  CreatePostPreview,
} from '~/components/AppBlocks/createPostFromAppGate';

/**
 * The BODY of the `CREATE_POST_FROM_APP` host-chrome consent dialog.
 *
 * 🔴 THIS COMPONENT IS THE CONSENT SCREEN, NOT A PREVIEW WIDGET. Its entire job
 * is to let the viewer compare what the sandboxed block SAID it would publish
 * against what the SERVER has resolved it will actually publish. Every value it
 * renders comes from `preview` — the server's resolution — and from `copy`, which
 * is derived from the same object. There is no prop on this component that a
 * block can set, and adding one would silently defeat the control.
 *
 * What it shows, and why each item is here rather than summarised away:
 *   - THUMBNAILS of the actual images. A count ("4 results") is what the existing
 *     publish confirm shows and it cannot distinguish the four images the block
 *     displayed from four completely different ones.
 *   - The EXACT title and detail, as PLAIN TEXT. Rendered through React's normal
 *     text interpolation — never `dangerouslySetInnerHTML` — so block-authored
 *     markup cannot render as markup inside host chrome.
 *   - The RESOLVED tag list, i.e. the tags that will actually be applied after
 *     existing-tags-only resolution. Showing the REQUESTED list would tell the
 *     viewer they are agreeing to tags that will not exist, and showing nothing
 *     would hide tags that will.
 *   - The DROPPED tags, so a viewer (and an app author debugging) can see that a
 *     requested tag was silently discarded rather than wondering later.
 *   - The DESTINATION in words, and the GALLERY target when present. Neither is
 *     visible in a thumbnail and both are the consequence that distinguishes this
 *     from the app's own grid.
 *
 * Empty title/detail render NOTHING rather than an empty row — an app posting
 * untitled images is normal, and a blank labelled row reads as a bug.
 */
export function CreatePostConsentBody({
  copy,
  preview,
}: {
  copy: CreatePostConsentCopy;
  preview: CreatePostPreview;
}) {
  return (
    <Stack gap="sm" data-testid="block-create-post-consent">
      <Text size="sm">{copy.intro}</Text>

      {preview.images.length > 0 && (
        <Group gap="xs" wrap="wrap" data-testid="block-create-post-thumbs">
          {preview.images.map((img, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={`${img.url}-${i}`}
              src={img.url}
              alt={`Image ${i + 1} of ${preview.images.length} in this post`}
              width={72}
              height={72}
              style={{ objectFit: 'cover', borderRadius: 6 }}
            />
          ))}
        </Group>
      )}

      {preview.title && (
        <div>
          <Text size="xs" c="dimmed">
            Title
          </Text>
          <Text size="sm" data-testid="block-create-post-title">
            {preview.title}
          </Text>
        </div>
      )}

      {preview.detail && (
        <div>
          <Text size="xs" c="dimmed">
            Description
          </Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }} data-testid="block-create-post-detail">
            {preview.detail}
          </Text>
        </div>
      )}

      {preview.tags.length > 0 && (
        <div>
          <Text size="xs" c="dimmed">
            Tags
          </Text>
          <Group gap={4} data-testid="block-create-post-tags">
            {preview.tags.map((tag) => (
              <Badge key={tag} size="sm" variant="light">
                {tag}
              </Badge>
            ))}
          </Group>
        </div>
      )}

      {copy.droppedTagsLine && (
        <Text size="xs" c="dimmed" data-testid="block-create-post-dropped-tags">
          {copy.droppedTagsLine}
        </Text>
      )}

      <Text size="sm" data-testid="block-create-post-destination">
        {copy.destination}
      </Text>

      {copy.galleryLine && (
        <Text size="sm" fw={500} data-testid="block-create-post-gallery">
          {copy.galleryLine}
        </Text>
      )}
    </Stack>
  );
}
