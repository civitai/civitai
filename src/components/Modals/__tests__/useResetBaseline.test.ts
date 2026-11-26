// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useForm } from 'react-hook-form';
import { describe, expect, it } from 'vitest';
import { useResetBaseline } from '../useResetBaseline';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Profile = { location: string; leaderboardShowcase: string | null };

function renderEditor(initial: Profile | undefined) {
  let values = initial;
  const result = {} as {
    form: ReturnType<typeof useForm<Profile>>;
    baseline: ReturnType<typeof useResetBaseline<Profile>>;
  };
  const root = createRoot(document.createElement('div'));
  const Probe = () => {
    result.form = useForm<Profile>();
    result.baseline = useResetBaseline(values, result.form.reset);
    return null;
  };
  act(() => root.render(createElement(Probe)));
  return {
    result,
    refetch: (next: Profile) => {
      values = next;
      act(() => root.render(createElement(Probe)));
    },
  };
}

describe('useResetBaseline', () => {
  it('moves the save baseline to the refetched values along with the form', () => {
    const cached = { location: 'Paris', leaderboardShowcase: null };
    const refetched = { location: 'Paris', leaderboardShowcase: 'overall' };
    const { result, refetch } = renderEditor(cached);
    expect(result.baseline.current).toEqual(cached);

    refetch(refetched);

    expect(result.form.getValues()).toEqual(refetched);
    expect(result.baseline.current).toEqual(refetched);
  });
});
