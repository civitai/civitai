// The control: the same probe WITHOUT loading the preview config, so nothing redacts.
// If the fake credential does not appear in this run's output, the probe cannot leak
// and a clean redacted run would prove nothing.
export default {
  testDir: '.',
  outputDir: process.env.LEAK_PROBE_OUT,
  retries: 0,
  workers: 1,
  projects: [{ name: 'leak-probe', testMatch: /leak-probe\.pw\.ts$/ }],
};
