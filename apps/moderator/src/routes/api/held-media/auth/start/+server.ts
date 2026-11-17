import { sheetStartHandlers } from '$lib/server/sheet-start';

export const { GET, POST } = sheetStartHandlers({
  tier: 'held',
  heading: 'Open held media on your phone?',
  batchRequired: false,
});
