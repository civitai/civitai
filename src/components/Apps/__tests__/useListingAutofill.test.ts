// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The SHARED external-listing autofill hook. Covers the behavioural contract the two
 * wizards rely on: auto-fires once per valid URL, re-fires on a URL change, never fires
 * for an invalid/empty URL, fill-if-empty never clobbers an edited field, and repull()
 * re-runs the query. The debounce timing itself is a library concern — `useDebouncedValue`
 * is mocked to identity so the auto-trigger fires synchronously; the query is mocked so we
 * drive the settle deterministically.
 */

// React 18.3 exposes `act` on the `react` export; borrow the typed signature.
const act = (React as unknown as { act: typeof actType }).act;

vi.mock('@mantine/hooks', () => ({
  useDebouncedValue: (v: unknown) => [v],
}));

const queryMock = vi.hoisted(() => ({
  state: { data: undefined, isFetching: false, isError: false } as {
    data?: unknown;
    isFetching?: boolean;
    isError?: boolean;
  },
  refetch: vi.fn(),
  inputs: [] as Array<{ url: string }>,
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    appListings: {
      fetchListingMetaFromUrl: {
        useQuery: (input: { url: string }) => {
          queryMock.inputs.push(input);
          return { ...queryMock.state, refetch: queryMock.refetch };
        },
      },
    },
  },
}));

import {
  useListingAutofill,
  type UseListingAutofillReturn,
} from '~/components/Apps/useListingAutofill';
import {
  emptyOffsiteSubmitForm,
  type OffsiteSubmitFormValues,
} from '~/components/Apps/offsiteSubmitFormConfig';

let api: UseListingAutofillReturn;
let currentValues: OffsiteSubmitFormValues;
let setUrl: (u: string) => void;
let edit: (patch: Partial<OffsiteSubmitFormValues>) => void;
let bump: () => void;

function Harness({ initial }: { initial?: Partial<OffsiteSubmitFormValues> }) {
  const [values, setValues] = React.useState<OffsiteSubmitFormValues>(() => ({
    ...emptyOffsiteSubmitForm(),
    ...initial,
  }));
  const [, setTick] = React.useState(0);
  const valuesRef = React.useRef(values);
  valuesRef.current = values;
  const nameFallbackRef = React.useRef('');
  api = useListingAutofill({
    externalUrl: values.externalUrl,
    setValues,
    valuesRef,
    nameFallbackRef,
  });
  currentValues = values;
  setUrl = (u) => setValues((v) => ({ ...v, externalUrl: u }));
  edit = (patch) => setValues((v) => ({ ...v, ...patch }));
  bump = () => setTick((t) => t + 1);
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  queryMock.state = { data: undefined, isFetching: false, isError: false };
  queryMock.refetch.mockReset();
  queryMock.inputs.length = 0;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(initial?: Partial<OffsiteSubmitFormValues>) {
  act(() => root.render(React.createElement(Harness, { initial })));
}
function lastInputUrl(): string | undefined {
  return queryMock.inputs[queryMock.inputs.length - 1]?.url;
}
function settle(data: unknown, extra: Partial<typeof queryMock.state> = {}) {
  act(() => {
    queryMock.state = { data, isFetching: false, isError: false, ...extra };
    bump();
  });
}

describe('useListingAutofill', () => {
  it('does NOT fire for an empty or invalid (non-https) URL', () => {
    render();
    expect(lastInputUrl()).toBe(''); // metaUrl null → query disabled with empty url
    act(() => setUrl('http://insecure.example.com')); // http rejected by normalizeLinkUrl
    expect(lastInputUrl()).toBe('');
    expect(queryMock.refetch).not.toHaveBeenCalled();
  });

  it('auto-fires ONCE per valid URL (a re-render with the same URL does not re-fire)', () => {
    render();
    act(() => setUrl('https://vitrine.civitai.com'));
    // Fired with the NORMALIZED url.
    expect(lastInputUrl()).toBe('https://vitrine.civitai.com/');
    // A plain re-render (same URL) must not trigger a refetch (once-per-url guard).
    act(() => bump());
    expect(queryMock.refetch).not.toHaveBeenCalled();
    expect(lastInputUrl()).toBe('https://vitrine.civitai.com/');
  });

  it('re-fires when the URL changes to a new valid URL', () => {
    render();
    act(() => setUrl('https://a.example.com'));
    expect(lastInputUrl()).toBe('https://a.example.com/');
    act(() => setUrl('https://b.example.com'));
    expect(lastInputUrl()).toBe('https://b.example.com/');
  });

  it('fill-if-empty applies name + description on settle (full pull → applied)', () => {
    render();
    act(() => setUrl('https://vitrine.civitai.com'));
    settle({
      name: 'Vitrine',
      description: 'A gallery',
      coverImageUrl: 'https://cdn/c.png',
      iconImageUrl: 'https://cdn/i.png',
    });
    expect(currentValues.name).toBe('Vitrine');
    expect(currentValues.description).toBe('A gallery');
    // Exposed name + description + cover + icon → nothing missing → applied.
    expect(api.result?.status).toBe('applied');
  });

  it('never clobbers a field the author already edited', () => {
    render();
    act(() => setUrl('https://vitrine.civitai.com'));
    act(() => edit({ name: 'My Own Name' }));
    settle({ name: 'OG Title', description: 'desc' });
    // Edited name preserved; empty description filled.
    expect(currentValues.name).toBe('My Own Name');
    expect(currentValues.description).toBe('desc');
  });

  it('surfaces the inline data-URI icon as a suggestion on settle', () => {
    render();
    act(() => setUrl('https://radio.example.com'));
    settle({ name: 'AI Radio', iconDataUri: 'data:image/svg+xml,%3Csvg%2F%3E' });
    expect(api.suggestions.iconDataUri).toBe('data:image/svg+xml,%3Csvg%2F%3E');
    // Name already implicitly filled; description/cover absent → partial.
    expect(api.result?.status).toBe('partial');
  });

  it('repull() re-runs the query for the current URL (refetch on the same url)', () => {
    render();
    act(() => setUrl('https://vitrine.civitai.com'));
    settle({ name: 'Vitrine' });
    queryMock.refetch.mockClear();
    act(() => api.repull());
    expect(queryMock.refetch).toHaveBeenCalledTimes(1);
  });

  it('an error-settled fetch produces the error status', () => {
    render();
    act(() => setUrl('https://broken.example.com'));
    settle(undefined, { isError: true });
    expect(api.result?.status).toBe('error');
  });
});
