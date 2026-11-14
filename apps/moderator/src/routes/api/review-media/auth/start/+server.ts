import { sheetStartHandlers } from '$lib/server/sheet-start';

export const { GET, POST } = sheetStartHandlers({
  tier: 'general',
  heading: 'Open these images on your phone?',
  batchRequired: true,
});
