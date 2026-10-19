export type FlowStep = 'basics' | 'items' | 'publish' | 'sell';

export const STEPS: readonly (readonly [FlowStep, string])[] = [
  ['basics', 'Basics'],
  ['items', 'Items'],
  ['publish', 'Publish'],
  ['sell', 'Sell'],
];

export const NEXT_LABEL: Record<FlowStep, string> = {
  basics: 'Pick items',
  items: 'Check and publish',
  publish: 'Sell it',
  sell: 'Done',
};
