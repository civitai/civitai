// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type { act as actType } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import * as z from 'zod';
import { numericString } from '~/utils/zod-helpers';

const act = (React as unknown as { act: typeof actType }).act;

const replace = vi.fn();
let routerQuery: Record<string, unknown> = {};
vi.mock('next/router', () => ({
  useRouter: () => ({ query: routerQuery, pathname: '/images', replace }),
}));

import { useZodRouteParams } from '~/hooks/useZodRouteParams';

const schema = z.object({ postId: numericString(), sort: z.string() }).partial();

function renderRouteParams() {
  let result!: ReturnType<typeof useZodRouteParams<typeof schema>>;
  function Probe() {
    result = useZodRouteParams(schema);
    return null;
  }
  act(() => createRoot(document.createElement('div')).render(React.createElement(Probe)));
  return result;
}

describe('useZodRouteParams', () => {
  beforeEach(() => {
    replace.mockClear();
    routerQuery = { postId: 'null', sort: 'Newest' };
  });

  it('keeps the valid params beside a junk one in the URL', () => {
    expect(renderRouteParams().query).toEqual({ sort: 'Newest' });
  });

  it('replace drops junk already in the URL', () => {
    renderRouteParams().replace({ sort: 'Oldest' });
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace.mock.calls[0][0]).toEqual({ pathname: '/images', query: { sort: 'Oldest' } });
  });

  it('replace still throws on a bad value the caller passes', () => {
    expect(() => renderRouteParams().replace({ postId: 'abc' })).toThrow();
    expect(replace).not.toHaveBeenCalled();
  });
});
