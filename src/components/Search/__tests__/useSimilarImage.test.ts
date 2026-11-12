import { describe, expect, it } from 'vitest';
import { connectSimilarImage } from '~/components/Search/useSimilarImage';

// Stands in for the helper's SearchParameters: `setQueryParameter` returns a copy with the key set.
type State = Record<string, unknown> & {
  setQueryParameter: (key: string, value: unknown) => State;
};
const searchParameters = (values: Record<string, unknown> = {}): State => ({
  ...values,
  setQueryParameter(key, value) {
    return searchParameters({ ...values, [key]: value });
  },
});

const widget = () => connectSimilarImage(() => undefined)({});

describe('connectSimilarImage', () => {
  it('sends similarTo from the UI state with the search and writes it back', () => {
    const w = widget();
    const params = w.getWidgetSearchParameters!(
      searchParameters() as never,
      {
        uiState: { similarTo: 42 },
      } as never
    ) as unknown as State;
    expect(params.similarTo).toBe(42);

    const uiState = w.getWidgetUiState!({ query: '' }, { searchParameters: params } as never);
    expect(uiState).toEqual({ query: '', similarTo: 42 });
  });

  it('leaves similarTo out of both when the UI state has none', () => {
    const w = widget();
    const params = w.getWidgetSearchParameters!(
      searchParameters() as never,
      {
        uiState: {},
      } as never
    ) as unknown as State;
    expect(params.similarTo).toBeUndefined();

    const uiState = w.getWidgetUiState!(
      { similarTo: 7 } as never,
      {
        searchParameters: params,
      } as never
    );
    expect(uiState).not.toHaveProperty('similarTo');
  });
});
