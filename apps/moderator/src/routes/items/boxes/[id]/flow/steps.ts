export type FlowStep = 'basics' | 'items' | 'publish' | 'sell';

export const STEPS: readonly (readonly [FlowStep, string])[] = [
  ['basics', 'Basics'],
  ['items', 'Items'],
  ['publish', 'Publish'],
  ['sell', 'Sell'],
];
