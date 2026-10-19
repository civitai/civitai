import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchDebouncer, searchHref } from '../search-debounce';

describe('searchDebouncer', () => {
  let submitted: string[];
  let current: string;
  const make = () =>
    searchDebouncer({
      delay: 300,
      current: () => current,
      submit: (value) => {
        submitted.push(value);
        current = value;
      },
    });

  beforeEach(() => {
    vi.useFakeTimers();
    submitted = [];
    current = '';
  });
  afterEach(() => vi.useRealTimers());

  it('submits once typing pauses, with the last value', () => {
    const search = make();
    search.input('a');
    vi.advanceTimersByTime(200);
    search.input('an');
    vi.advanceTimersByTime(200);
    search.input('ani');
    expect(submitted).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(submitted).toEqual(['ani']);
  });

  it('submits on Enter at once, and drops the pending pause', () => {
    const search = make();
    search.input('anime');
    search.enter('anime');
    expect(submitted).toEqual(['anime']);
    vi.advanceTimersByTime(1000);
    expect(submitted).toEqual(['anime']);
  });

  it('does not submit a value the page already shows, ignoring surrounding spaces', () => {
    current = 'anime';
    const search = make();
    search.input('anime ');
    vi.advanceTimersByTime(300);
    search.enter(' anime');
    expect(submitted).toEqual([]);
  });

  it('submits a cleared box, so emptying it drops the search', () => {
    current = 'anime';
    const search = make();
    search.input('');
    vi.advanceTimersByTime(300);
    expect(submitted).toEqual(['']);
  });

  it('waits out an IME composition and submits what it produced', () => {
    const search = make();
    search.compositionStart();
    search.input('あ');
    search.enter('あ');
    vi.advanceTimersByTime(1000);
    expect(submitted).toEqual([]);
    search.compositionEnd('アニメ');
    vi.advanceTimersByTime(300);
    expect(submitted).toEqual(['アニメ']);
  });

  it('drops a pending submit when the page navigates away', () => {
    const search = make();
    search.input('anime');
    search.cancel();
    vi.advanceTimersByTime(1000);
    expect(submitted).toEqual([]);
  });
});

describe('searchHref', () => {
  const at = (path: string) => new URL(`https://mod.test${path}`);

  it('keeps the filters and sort, and drops the page, the open item and the old search', () => {
    expect(
      searchHref(at('/models/flags/auto?source=hash&sort=newest&page=3&item=7&q=old'), 'anime')
    ).toBe('/models/flags/auto?source=hash&sort=newest&q=anime');
  });

  it('drops q for an empty search', () => {
    expect(searchHref(at('/models/flags/auto?q=old&source=hash'), '  ')).toBe(
      '/models/flags/auto?source=hash'
    );
    expect(searchHref(at('/models/flags/auto?q=old'), '')).toBe('/models/flags/auto');
  });
});

describe('searchDebouncer.pending', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says whether a typed search is still waiting, so a landed page may reset the box only when none is', () => {
    let current = '';
    const search = searchDebouncer({
      delay: 300,
      current: () => current,
      submit: (v) => (current = v),
    });
    expect(search.pending()).toBe(false);
    search.input('foo');
    expect(search.pending()).toBe(true);
    vi.advanceTimersByTime(300);
    expect(search.pending()).toBe(false);
    search.input('bar');
    search.cancel();
    expect(search.pending()).toBe(false);
  });

  it('retries a search whose navigation never landed: it compares against the page, not the last send', () => {
    const page = '';
    const sent: string[] = [];
    const search = searchDebouncer({
      delay: 300,
      current: () => page,
      submit: (v) => sent.push(v),
    });
    search.enter('foo'); // the navigation is cancelled: the page still shows no search
    search.enter('foo');
    expect(sent).toEqual(['foo', 'foo']);
  });
});
