import type { GateRefusal } from '~/server/services/pre-publish-gate/types';

export const GATE_PENDING_MESSAGE =
  "We're checking this model before it goes live. It will publish automatically when the checks finish, usually within a few minutes.";

export const GATE_HELD_MESSAGE =
  'This model needs a quick review by our team before it goes live. It stays unpublished until then; check back on this page for the result.';

export const GATE_UNFINISHED_MESSAGE =
  "We couldn't finish checking this model, so it wasn't published. Publish it again to retry.";

export const GATE_REFUSAL_MESSAGES: Record<GateRefusal, string> = {
  nsfw: 'Models marked as mature content cannot use this base model.',
  images:
    "This model can't be published with its current showcase images. Replace them and publish again.",
  image_error:
    "One or more showcase images couldn't be checked. Re-upload or remove them, then publish again.",
  no_images: 'Add showcase images before publishing.',
};
