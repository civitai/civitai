import { Menu } from '@mantine/core';
import { IconArrowBackUp, IconPhotoUp } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { NextLink } from '~/components/NextLink/NextLink';
import { getStepMeta } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { generationGraphPanel } from '~/store/generation-graph.store';
import { orchestratorMediaTransmitter } from '~/store/post-image-transmitter.store';
import type { BlobData } from '~/shared/orchestrator/workflow-data';
import { imageGenerationDrawerZIndex } from '~/shared/constants/app-layout.constants';
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
   * so there is nothing to submit until a post exists. This is the same
   * create-post-and-transmit path the Post button uses, narrowed to one output,
   * and it lands on the post editor where the submit card is already rendered
   * for an image with provenance.
   *
   * Deliberately NOT a submit: no Buzz moves here, and the price is shown on the
   * card the poster arrives at. Charging from a surface that cannot show what a
   * gallery costs would be a spend without consent.
   */
  const postAndSubmit = async () => {
    try {
      const key = 'generator';
      orchestratorMediaTransmitter.setUrls(key, [
        {
          url: output.url,
          meta: getStepMeta(output.step),
          generationWorkflowId: output.workflowId,
        },
      ]);

      if (router.pathname === '/posts/[postId]/edit') {
        await router.replace(
          { pathname: '/posts/[postId]/edit', query: { postId: router.query.postId, src: key } },
          undefined,
          { shallow: true }
        );
        return;
      }

      const post = await createPost.mutateAsync({});
      await router.push({ pathname: '/posts/[postId]/edit', query: { postId: post.id, src: key } });
      generationGraphPanel.close();
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
    <Menu zIndex={imageGenerationDrawerZIndex + 2} withinPortal position="top" withArrow>
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
          onClick={postAndSubmit}
          // The label says what actually happens. "Submit" alone would promise a
          // submission from a surface that cannot make one, and the poster would
          // find themselves in the post editor wondering what they pressed.
        >
          Post &amp; submit this remix
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
