import { getFeatureFlags } from '~/server/services/feature-flags.service';

// Every v1 Knights of New Order server path that must stop once the old game is retired gates on this
// one symbol. Turning the `newOrderGame` flag off is the cutover. Remove with the v1 code.
export function isV1KnightsLive(): boolean {
  return !!getFeatureFlags({}).newOrderGame;
}
