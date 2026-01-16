/**
 * Complex Interaction Helpers
 *
 * These helpers are loaded into `ctx` for flows to use.
 * Usage in flow: await ctx.mantineSelect('Label', 'Option');
 */

module.exports = {
  mantineSelect: {
    fn: require('./mantine-select'),
    description: 'Select an option in a Mantine Select/Combobox component',
    usage: "await ctx.mantineSelect('Entry Limit', '10 entries')",
    identify: 'Input with role="combobox" or mantine-Select-* classes',
  },
  // Add more helpers here as needed
};
