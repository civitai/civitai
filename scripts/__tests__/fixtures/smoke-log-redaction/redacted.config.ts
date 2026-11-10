import previewConfig from '../../../../playwright.preview.config';

// Loads the REAL preview config (that import is what installs the redaction), then
// points it at the leak probe. Everything else is inherited.
export default {
  ...previewConfig,
  testDir: '.',
  outputDir: process.env.LEAK_PROBE_OUT,
  retries: 0,
  projects: [{ name: 'leak-probe', testMatch: /leak-probe\.pw\.ts$/ }],
};
