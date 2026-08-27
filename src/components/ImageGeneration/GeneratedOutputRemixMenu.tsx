import { Menu } from '@mantine/core';
import { IconArrowBackUp, IconPhotoUp } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink } from '~/components/NextLink/NextLink';
import { getStepMeta } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { postGeneratedMedia } from '~/components/ImageGeneration/utils/postGeneratedMedia';
import type { BlobData } from '~/shared/orchestrator/workflow-data';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * What a generated output can do with the image it was remixed from: go and look
 * at it, or turn this output into a post so it can be submitted to that image's
 * gallery.
 *
 * Hangs off `GeneratedOutput`, which is the one component both the generator
 * feed and the queue render their outputs through — so this is both surfaces,
 * not two implementations of the same button.
 *
 * The source id comes from the step's own `remixOfId`, which is the generator's
 * record of what this run started from. That is a weaker signal than the
 * server-verified `sourceImageIds` and it is the right one here: nothing is
 * being asserted to anyone else yet, and the only person who sees it is the
 * person who pressed Remix.
 */
export function GeneratedOutputRemixMenu({ output }: { output: BlobData }) {
  const features = useFeatureFlags();
  const router = useRouter();
  const createPost = trpc.post.create.useMutation();

  const remixOfId = output.remixOfId;

  /**
   * A generated output is not an `Image` row yet — it is an orchestrator blob —
   * so there is nothing to submit until a post exists. This creates the post and
   * hands the output over, landing on the post editor where the submit card
   * renders for an image with provenance.
   *
   * Deliberately NOT a submit: no Buzz moves here, and the price is shown on the
   * card the poster arrives at. Charging from a surface that cannot show what a
   * gallery costs would be a spend without consent. The label says so.
   */
  const postThisRemix = async () => {
    try {
      await postGeneratedMedia({
        media: [
          {
            url: output.url,
            meta: getStepMeta(output.step),
            generationWorkflowId: output.workflowId,
          },
        ],
        router,
        createPost: () => createPost.mutateAsync({}),
      });
    } catch (e) {
      showErrorNotification({
        title: 'Failed to create post',
        error: new Error((e as Error).message),
      });
    }
  };

  // Audio has no post system and no gallery to go to; the Post button filters it
  // out for the same reason.
  if (!features.remixGallery || !remixOfId || output.mediaType === 'audio') return null;

  return (
    /* Same z-index as the workflow menu three lines up in this footer. They
       share a stacking context, so two different numbers here is one of them
       being wrong. */
    <Menu zIndex={400} withinPortal position="top" withArrow>
      <Menu.Target>
        {/* No Tooltip wrapper. `Menu.Target` clones its child to attach the
            trigger handlers and ref, and the sibling menu in this footer targets
            the icon directly — a wrapper here is a second ref hop for no gain. */}
        <LegacyActionIcon size="md" loading={createPost.isPending} aria-label="Remix source">
          <IconArrowBackUp size={16} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<IconPhotoUp size={14} stroke={1.5} />}
          onClick={postThisRemix}
          // The label claims only what this does. "Post &amp; submit" promised the
          // half that is deferred — the poster would land in the editor, publish,
          // and have made no submission, with nothing having gone wrong.
        >
          Post this remix to submit it
        </Menu.Item>
        <Menu.Item
          component={NextLink}
          href={`/images/${remixOfId}`}
          target="_blank"
          leftSection={<IconArrowBackUp size={14} stroke={1.5} />}
        >
          View original
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
