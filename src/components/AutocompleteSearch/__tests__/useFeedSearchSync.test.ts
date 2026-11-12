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

  it('never searches as you type', () => {
    const render = mount();
    render({ debouncedSearch: 'red' });
    render({ debouncedSearch: 'red dragon' });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("writes committed text into the feed's URL, keeping its filters", () => {
    router.query = { baseModels: 'Illustrious' };
    const render = mount();
    render({ debouncedSearch: 'red dragon' });
    act(() => hook.commit('red dragon'));
    expect(replacedQueries()).toEqual([{ baseModels: 'Illustrious', query: 'red dragon' }]);
  });

  it('applies a commit only once the refusal checks have read that text', () => {
    const render = mount({ debouncedSearch: 'red' });
    act(() => hook.commit('red dragon'));
    expect(router.replace).not.toHaveBeenCalled();
    render({ debouncedSearch: 'red dragon' });
    expect(replacedQueries()).toEqual([{ query: 'red dragon' }]);
  });

  it('clears the search when the bar is cleared', () => {
    router.query = { query: 'cat' };
    const render = mount({ debouncedSearch: 'cat' });
    act(() => hook.commit(''));
    render({ debouncedSearch: '' });
    expect(replacedQueries()).toEqual([{}]);
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
    const render = mount({ blocked: true, debouncedSearch: 'refused words' });
    act(() => hook.commit('refused words'));
    render({ debouncedSearch: 'refused words', blocked: true });
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('does nothing on a page whose feed does not answer a query', () => {
    router.query = { query: 'red dragon' };
    mount({ enabled: false, debouncedSearch: 'cats' });
    act(() => hook.commit('cats'));
    expect(setSearch).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('does not put an earlier commit back in the bar when a later one is still on its way', () => {
    const render = mount({ debouncedSearch: 'red' });
    act(() => hook.commit('red'));
    render({ debouncedSearch: 'red dragon' });
    act(() => hook.commit('red dragon'));
    // The router shows the first write only now, after the second has gone out.
    router.query = { query: 'red' };
    render({ debouncedSearch: 'red dragon' });
    router.query = { query: 'red dragon' };
    render({ debouncedSearch: 'red dragon' });
    expect(setSearch).not.toHaveBeenCalled();
  });

  it('removes the user filter it added when the @user token is deleted, and keeps the rest', () => {
    router.query = { baseModels: 'Illustrious' };
    const render = mount({ debouncedSearch: 'dragon @alice' });
    act(() => hook.commit('dragon @alice'));
    router.query = { baseModels: 'Illustrious', query: 'dragon', username: 'alice' };
    render({ debouncedSearch: 'dragon' });
    act(() => hook.commit('dragon'));
    expect(replacedQueries().at(-1)).toEqual({ baseModels: 'Illustrious', query: 'dragon' });
  });
});
