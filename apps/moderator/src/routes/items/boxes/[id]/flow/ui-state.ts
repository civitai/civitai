import type { CatalogFilters } from '$lib/box-design';
import type { PriceBands, TierPreset } from '$lib/box-flow';
import type { FlowStep } from './steps';

/** Held by the page, not the flow: a save remounts the flow, and none of this should reset with it. */
export type FlowUi = {
  step: FlowStep;
  bands: PriceBands;
  preset: TierPreset;
  itemsTab: 'catalog' | 'box';
  filters: CatalogFilters;
  hideInBox: boolean;
};
