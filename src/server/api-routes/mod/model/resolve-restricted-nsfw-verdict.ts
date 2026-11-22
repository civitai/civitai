import { resolveRestrictedNsfwVerdict } from '~/server/services/text-scan/actions/restricted-nsfw-verdict';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { minorFlagRateLimit } from '~/server/schema/moderator/minor-flag';
import {
  resolveRestrictedNsfwVerdictInput,
  restrictedNsfwRulingArgs,
} from '~/server/schema/moderator/restricted-nsfw-verdict';

export default defineModeratorEndpoint('model.resolveRestrictedNsfwVerdict', {
  summary:
    'Rule on a model the text scan rated NSFW while its owner had marked it minor, a real person or SFW-only.',
  returns: '{ modelId, ruling, restriction, nsfw, sfwOnly }',
  notes: [
    "`keep` leaves the owner's rating; on a model an earlier scan had locked NSFW it also turns nsfw off and lifts that system lock.",
    '`dismiss` closes the lead and changes nothing else. On a minor lead it needs a `reason`.',
    '`rateNsfw` unsets SFW-only, sets nsfw and locks it. Refused on a model marked minor or a real person.',
    "`revision` is the lead as the moderator was shown it (`restrictedLeadRevision`); the ruling is refused if the lead, the model's flags and locks, or the scan shown have changed since.",
    'Refuses when the model has no pending lead. Every ruling logs a ModActivity row and records the values it replaced on the model.',
  ],
  rateLimit: minorFlagRateLimit,
  input: resolveRestrictedNsfwVerdictInput,
  async handler(input, ctx) {
    const result = await resolveRestrictedNsfwVerdict(
      restrictedNsfwRulingArgs(input, ctx.actor.id)
    );
    return { ...result, affected: { modelIds: [input.modelId] } };
  },
});
