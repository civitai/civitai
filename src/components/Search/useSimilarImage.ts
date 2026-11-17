import type { Connector, IndexUiState, InitOptions } from 'instantsearch.js';
import { useConnector } from 'react-instantsearch';

/**
 * "More like this": the image whose vector is the query. Kept as a `similarTo` search parameter so
 * the semantic image search client receives it, and in the UI state so the URL carries it. A widget
 * is needed for both: InstantSearch drops UI state and parameters no widget claims.
 */
type SimilarImageDescription = {
  $$type: 'civitai.similarImage';
  renderState: { imageId?: number; refine: (imageId?: number) => void };
  indexRenderState: {
    similarImage: { imageId?: number; refine: (imageId?: number) => void };
  };
  indexUiState: { similarTo?: number };
};

type SearchParameters = InitOptions['state'];
type Params = Record<string, unknown>;

const PARAM = 'similarTo';

function readParam(state: SearchParameters) {
  const value = (state as SearchParameters & { [PARAM]?: number })[PARAM];
  return value || undefined;
}

// The helper types only Algolia's own parameters; it passes any other one through to the client.
function withParam(state: SearchParameters, imageId: number | undefined) {
  return state.setQueryParameter(PARAM as never, imageId as never);
}

export const connectSimilarImage: Connector<SimilarImageDescription, Params> =
  (renderFn, unmountFn = () => undefined) =>
  (widgetParams) => ({
    $$type: 'civitai.similarImage',
    init(initOptions) {
      renderFn(
        {
          ...this.getWidgetRenderState(initOptions),
          instantSearchInstance: initOptions.instantSearchInstance,
        },
        true
      );
    },
    render(renderOptions) {
      renderFn(
        {
          ...this.getWidgetRenderState(renderOptions),
          instantSearchInstance: renderOptions.instantSearchInstance,
        },
        false
      );
    },
    dispose({ state }) {
      unmountFn();
      return withParam(state, undefined);
    },
    getRenderState(renderState, renderOptions) {
      return { ...renderState, similarImage: this.getWidgetRenderState(renderOptions) };
    },
    getWidgetRenderState({ helper, state }) {
      return {
        imageId: readParam(state),
        refine: (imageId?: number) => {
          helper.setState(withParam(helper.state, imageId)).search();
        },
        widgetParams,
      };
    },
    getWidgetUiState(uiState, { searchParameters }) {
      const { [PARAM]: _, ...rest } = uiState as IndexUiState & { similarTo?: number };
      const imageId = readParam(searchParameters);
      return imageId ? { ...rest, [PARAM]: imageId } : rest;
    },
    getWidgetSearchParameters(searchParameters, { uiState }) {
      const imageId = (uiState as IndexUiState & { similarTo?: number })[PARAM];
      return withParam(searchParameters, imageId);
    },
  });

export function useSimilarImage() {
  // react-instantsearch types against its own copy of instantsearch.js, not the root dependency.
  return useConnector<Params, SimilarImageDescription>(
    connectSimilarImage as never,
    {},
    { $$widgetType: 'civitai.similarImage' }
  );
}
