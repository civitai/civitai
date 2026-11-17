import { updateCosmetic } from '~/server/services/cosmetic.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { cosmeticId, cosmeticShape } from '~/server/schema/moderator/cosmetic';

export default defineModeratorEndpoint('cosmetic.update', {
  summary: 'Change a cosmetic.',
  returns: '{ id }',
  notes: ['Every field is optional; omitted ones are left as they are.'],
  rateLimit: { max: 30, windowSeconds: 60 },
  input: cosmeticShape
    .partial()
    .extend({ cosmeticId: cosmeticId.describe('The cosmetic to change.') }),
  async handler(input) {
    const { cosmeticId: id, ...patch } = input;
    const cosmetic = await updateCosmetic({ id, data: patch as never });
    return { id: cosmetic.id, affected: { cosmeticIds: [cosmetic.id] } };
  },
});
