import { getStepMeta } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import type { PostableGeneratedMedia } from '~/components/ImageGeneration/utils/postGeneratedMedia';
import { buildSongDetails } from '~/shared/form-graph/generation/audio/song-metadata';
import type { BlobData } from '~/shared/orchestrator/workflow-data';

type PostableOutput = Pick<BlobData, 'url' | 'workflowId' | 'step' | 'mediaType' | 'params'> & {
  workflow: Pick<BlobData['workflow'], 'metadata'>;
};

/**
 * What the post editor is handed for a generated output. A song is flagged by its step, not by its
 * blob: an ACE song with a cover is a VideoBlob. A simple-mode song's lyrics, bpm and key exist
 * only in the drafting chat step, which the client never receives; the server fills them in when
 * the image is added.
 */
export function toPostableMedia(output: PostableOutput): PostableGeneratedMedia {
  const media: PostableGeneratedMedia = {
    url: output.url,
    meta: getStepMeta(output.step),
    generationWorkflowId: output.workflowId,
  };
  if (output.mediaType === 'audio') {
    media.mediaType = 'audio';
    media.audioMetadata = buildSongDetails({
      ...output.workflow?.metadata?.params,
      ...output.params,
    });
  }
  return media;
}
