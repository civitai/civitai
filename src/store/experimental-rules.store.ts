/**
 * Experimental gate rules, mirrored out of the generator config query.
 *
 * The flask marks items inside presentational components (`ResourceItemContent`)
 * and inside pickers that render as portalled dialogs on mobile. Reading the
 * tRPC-backed config from those directly would give a display component a data
 * dependency of its own, and throws outright wherever no tRPC provider is
 * mounted — which is every component suite that renders one.
 *
 * So `ExperimentalRulesSync`, mounted once by `GenerationFormProvider`, mirrors
 * the rules here and every marker reads the store. Empty until synced, which
 * renders no marker rather than failing.
 */

import { create } from 'zustand';
import type { GateRule } from '~/shared/data-graph/generation/gates';

type ExperimentalRulesState = { rules: GateRule[] };

export const useExperimentalRulesStore = create<ExperimentalRulesState>(() => ({ rules: [] }));

export const setExperimentalRules = (rules: GateRule[]) => {
  if (useExperimentalRulesStore.getState().rules !== rules)
    useExperimentalRulesStore.setState({ rules });
};
