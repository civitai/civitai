// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const router = vi.hoisted(() => ({
  pathname: '/images',
  query: {} as Record<string, string>,
  replace: vi.fn(),
}));
vi.mock('next/router', () => ({ useRouter: () => router }));

import { useFeedSearchSync } from '../useFeedSearchSync';

type Props = Parameters<typeof useFeedSearchSync>[0];
let hook: ReturnType<typeof useFeedSearchSync>;
const setSearch = vi.fn();

function Harness(props: Props) {
  hook = useFeedSearchSync(props);
  return null;
}

function mount(initial: Partial<Props> = {}) {
  const root = createRoot(document.createElement('div'));
  const props: Props = {
    enabled: true,
    debouncedSearch: '',
    setSearch,
    blocked: false,
    ...initial,
  };
  const render = (next: Partial<Props> = {}) =>
    act(() => root.render(createElement(Harness, { ...props, ...next })));
  render();
  return render;
}

const replacedQueries = () => router.replace.mock.calls.map(([url]) => url.query);

describe('useFeedSearchSync', () => {
  beforeEach(() => {
    router.query = {};
    router.replace.mockReset();
    setSearch.mockReset();
  });

  it("writes what the user types into the feed's URL, keeping its filters", () => {
    router.query = { baseModels: 'Illustrious' };
    const render = mount();
    hook.markTyped();
    render({ debouncedSearch: 'red dragon' });
    expect(replacedQueries()).toEqual([{ baseModels: 'Illustrious', query: 'red dragon' }]);
  });

  it('seeds the bar from a URL it did not write, without writing the URL back', () => {
    router.query = { query: 'red dragon' };
    mount();
    expect(setSearch).toHaveBeenCalledWith('red dragon');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('re-seeds the bar when the feed clears the search', () => {
    router.query = { query: 'red dragon' };
    const render = mount();
    router.query = {};
    render();
    expect(setSearch).toHaveBeenLastCalledWith('');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('never sends a refused query to the feed', () => {
    const render = mount({ blocked: true });
    hook.markTyped();
    render({ debouncedSearch: 'refused words', blocked: true });
    hook.applyNow('refused words');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('does nothing on a page whose feed does not answer a query', () => {
    router.query = { query: 'red dragon' };
    const render = mount({ enabled: false });
    hook.markTyped();
    render({ enabled: false, debouncedSearch: 'cats' });
    expect(setSearch).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });
});

describe('useFeedSearchSync when the router lags its own writes', () => {
  beforeEach(() => {
    router.query = {};
    router.replace.mockReset();
    setSearch.mockReset();
  });

  it('does not put an earlier write back in the bar when a later one is still on its way', () => {
    const render = mount();
    hook.markTyped();
    render({ debouncedSearch: 'red' });
    render({ debouncedSearch: 'red dragon' });
    // The router shows the first write only now, after the second has gone out.
    router.query = { query: 'red' };
    render({ debouncedSearch: 'red dragon' });
    router.query = { query: 'red dragon' };
    render({ debouncedSearch: 'red dragon' });
    expect(setSearch).not.toHaveBeenCalled();
  });

  it('re-seeds from Back even when it lands where the search started', () => {
    router.query = { query: 'cat' };
    const render = mount();
    setSearch.mockReset();
    hook.markTyped();
    render({ debouncedSearch: 'red dragon' });
    router.query = { query: 'red dragon' };
    render({ debouncedSearch: 'red dragon' });
    router.query = { query: 'cat' };
    render({ debouncedSearch: 'red dragon' });
    expect(setSearch).toHaveBeenCalledWith('cat');
  });
});
