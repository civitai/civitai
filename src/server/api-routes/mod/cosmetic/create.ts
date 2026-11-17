import { createCosmetic } from '~/server/services/cosmetic.service';
import { defineModeratorEndpoint } from '~/server/utils/moderator-endpoint';
import { cosmeticShape } from '~/server/schema/moderator/cosmetic';

export default defineModeratorEndpoint('cosmetic.create', {
  summary: 'Create a cosmetic.',
  returns: '{ id }',
  rateLimit: { max: 20, windowSeconds: 60 },
  input: cosmeticShape,
  async handler(input) {
    const cosmetic = await createCosmetic(input as never);
    return { id: cosmetic.id, affected: { cosmeticIds: [cosmetic.id] } };
  },
});
