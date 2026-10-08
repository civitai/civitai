/**
 * What the form footer's Reset button clears: the active family's settings only. The ecosystem
 * and workflow stay, so Reset doesn't send the user back to the default ecosystem, and other
 * families keep what the user chose there.
 *
 * Its own module, with no imports, so a unit test can bind to this object instead of restating
 * the list: `FormFooter.tsx` carries an import graph too heavy for a unit suite.
 */
export const FOOTER_RESET = {
  exclude: ['ecosystem', 'workflow', 'outputFormat', 'priority'],
  scope: 'active',
} as const;
