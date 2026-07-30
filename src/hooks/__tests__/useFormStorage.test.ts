// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import * as z from 'zod';

// React 18.3 exposes `act` on the `react` export, but our @types/react (18.0.14) predates that
// typing. Use the runtime `React.act` and borrow the correctly-typed signature.
const act = (React as unknown as { act: typeof actType }).act;

// --- module mocks (must be declared before importing the hook) ---
const { openConfirmModalMock, showErrorNotificationMock } = vi.hoisted(() => ({
  openConfirmModalMock: vi.fn(),
  showErrorNotificationMock: vi.fn(),
}));
vi.mock('@mantine/modals', () => ({ openConfirmModal: openConfirmModalMock }));
vi.mock('~/utils/notifications', () => ({ showErrorNotification: showErrorNotificationMock }));

import {
  FORM_STORAGE_TTL_MS,
  mergeRestoredValues,
  persistedValueLostIdentity,
  readStoredFormValue,
  serializeStoredFormValue,
  useFormStorage,
} from '~/hooks/useFormStorage';

const NOW = 1_800_000_000_000;

describe('readStoredFormValue — TTL', () => {
  it('offers an entry written inside the window', () => {
    const raw = serializeStoredFormValue({ title: 'draft' }, NOW - 60_000);
    expect(readStoredFormValue(raw, { now: NOW })).toEqual({ value: { title: 'draft' } });
  });

  it('drops an entry older than the TTL', () => {
    const raw = serializeStoredFormValue({ title: 'draft' }, NOW - FORM_STORAGE_TTL_MS - 1);
    expect(readStoredFormValue(raw, { now: NOW })).toBeNull();
  });

  it('drops an entry exactly at the TTL boundary', () => {
    const raw = serializeStoredFormValue({ title: 'draft' }, NOW - FORM_STORAGE_TTL_MS);
    expect(readStoredFormValue(raw, { now: NOW })).toBeNull();
  });

  it('drops a legacy unstamped entry — its age cannot be bounded', () => {
    expect(readStoredFormValue(JSON.stringify({ title: 'draft' }), { now: NOW })).toBeNull();
  });

  it('drops absent or unparseable entries', () => {
    expect(readStoredFormValue(null, { now: NOW })).toBeNull();
    expect(readStoredFormValue('{not json', { now: NOW })).toBeNull();
  });

  it('preserves a falsy stored value rather than confusing it with "nothing stored"', () => {
    expect(readStoredFormValue(serializeStoredFormValue(0, NOW), { now: NOW })).toEqual({
      value: 0,
    });
  });
});

describe('persistedValueLostIdentity', () => {
  const loaded = { id: 55, url: 'key-a', name: 'cover.png' };

  it('flags a persisted copy of the SAME object that dropped the server id', () => {
    expect(persistedValueLostIdentity({ url: 'key-a', name: 'cover.png' }, loaded)).toBe(true);
  });

  it('does not flag a genuinely different image the user swapped in offline', () => {
    expect(persistedValueLostIdentity({ url: 'key-b', name: 'new.png' }, loaded)).toBe(false);
  });

  it('does not flag when the persisted value carries its own id', () => {
    expect(persistedValueLostIdentity({ id: 55, url: 'key-a' }, loaded)).toBe(false);
  });

  it('does not flag when nothing was loaded to protect', () => {
    expect(persistedValueLostIdentity({ url: 'key-a' }, null)).toBe(false);
    expect(persistedValueLostIdentity({ url: 'key-a' }, { url: 'key-a' })).toBe(false);
  });
});

describe('mergeRestoredValues', () => {
  it('lets the persisted draft win by default (unchanged behaviour)', () => {
    expect(
      mergeRestoredValues({
        current: { title: 'server', body: 'server' },
        stored: { title: 'draft' },
      })
    ).toEqual({ title: 'draft', body: 'server' });
  });

  it('keeps the current value for a field the opt-in predicate vetoes', () => {
    const current = { coverImage: { id: 55, url: 'key-a' }, title: 'server' };
    expect(
      mergeRestoredValues({
        current,
        stored: { coverImage: { url: 'key-a' }, title: 'draft' },
        shouldRestoreField: ({ name, storedValue, currentValue }) =>
          name !== 'coverImage' || !persistedValueLostIdentity(storedValue, currentValue),
      })
    ).toEqual({ coverImage: { id: 55, url: 'key-a' }, title: 'draft' });
  });
});

// --- hook-level integration -------------------------------------------------------------

const schema = z.object({
  title: z.string(),
  coverImage: z.object({ id: z.number().optional(), url: z.string() }).nullish(),
});

type FakeForm = {
  watch: ReturnType<typeof vi.fn>;
  getValues: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
};

function makeForm(values: Record<string, unknown>): FakeForm {
  return {
    watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
    getValues: vi.fn(() => values),
    reset: vi.fn(),
  };
}

const KEY = 'article_1';

function renderHook(
  form: FakeForm,
  shouldRestoreField?: Parameters<typeof useFormStorage>[0]['shouldRestoreField']
) {
  const container = document.createElement('div');
  const root = createRoot(container);
  function Probe() {
    useFormStorage({
      schema: schema as any,
      form: form as any,
      timeout: 1000,
      key: KEY,
      watch: (value: any) => value,
      shouldRestoreField,
    });
    return null;
  }
  act(() => {
    root.render(React.createElement(Probe));
  });
  return () => act(() => root.unmount());
}

// happy-dom in this version does not provide `localStorage` (and Node's experimental global is
// off without --localstorage-file), so stand up a minimal in-memory Storage for the hook to use.
function installLocalStorage() {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  return storage;
}

let localStorage: ReturnType<typeof installLocalStorage>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage = installLocalStorage();
  openConfirmModalMock.mockReset();
  showErrorNotificationMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useFormStorage on mount', () => {
  it('never offers an expired draft, and clears it', () => {
    localStorage.setItem(
      KEY,
      serializeStoredFormValue({ title: 'stale' }, NOW - FORM_STORAGE_TTL_MS - 1)
    );

    const unmount = renderHook(makeForm({ title: 'server' }));

    expect(openConfirmModalMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
    unmount();
  });

  it('offers a fresh draft', () => {
    localStorage.setItem(KEY, serializeStoredFormValue({ title: 'draft' }, NOW - 60_000));

    const unmount = renderHook(makeForm({ title: 'server' }));

    expect(openConfirmModalMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not let a persisted cover image clobber the loaded one it is a stale copy of', () => {
    // The upload widget emits `{ url }` with no `id`; the loaded article has the identified
    // row. Restoring verbatim is what makes the server treat an existing image as brand new.
    localStorage.setItem(
      KEY,
      serializeStoredFormValue({ title: 'draft', coverImage: { url: 'key-a' } }, NOW - 60_000)
    );
    const form = makeForm({ title: 'server', coverImage: { id: 55, url: 'key-a' } });

    const unmount = renderHook(
      form,
      ({ name, storedValue, currentValue }) =>
        name !== 'coverImage' || !persistedValueLostIdentity(storedValue, currentValue)
    );

    act(() => {
      openConfirmModalMock.mock.calls[0][0].onConfirm();
    });

    expect(showErrorNotificationMock).not.toHaveBeenCalled();
    expect(form.reset).toHaveBeenCalledTimes(1);
    expect(form.reset.mock.calls[0][0]).toEqual({
      title: 'draft',
      coverImage: { id: 55, url: 'key-a' },
    });
    unmount();
  });

  it('still restores a cover the user genuinely replaced while offline', () => {
    localStorage.setItem(
      KEY,
      serializeStoredFormValue({ title: 'draft', coverImage: { url: 'key-b' } }, NOW - 60_000)
    );
    const form = makeForm({ title: 'server', coverImage: { id: 55, url: 'key-a' } });

    const unmount = renderHook(
      form,
      ({ name, storedValue, currentValue }) =>
        name !== 'coverImage' || !persistedValueLostIdentity(storedValue, currentValue)
    );

    act(() => {
      openConfirmModalMock.mock.calls[0][0].onConfirm();
    });

    expect(form.reset.mock.calls[0][0]).toEqual({
      title: 'draft',
      coverImage: { url: 'key-b' },
    });
    unmount();
  });
});

describe('useFormStorage writes', () => {
  it('stamps a write time so the entry can expire', () => {
    const form = makeForm({ title: 'server' });
    const unmount = renderHook(form);

    // Drive the `form.watch` subscription the hook registered.
    const onChange = form.watch.mock.calls[0][0];
    act(() => {
      onChange({ title: 'typed' }, {});
      vi.advanceTimersByTime(1000);
    });

    // The debounce advanced the (faked) clock by its 1s timeout before the write ran.
    expect(JSON.parse(localStorage.getItem(KEY) as string)).toEqual({
      savedAt: NOW + 1000,
      value: { title: 'typed' },
    });
    unmount();
  });
});
