import { describe, expect, it } from 'vitest';
import { userWorkflowsRequest, workflowIdsParam } from '../user-workflows-request';

const base = { source: 'all' as const, cursor: '' };

describe('userWorkflowsRequest', () => {
  it.each([[''], ['junk'], ['5-20260101000000000']])(
    'reads only the listed ids for workflows=%j, never the paged history',
    (workflowIds) => {
      const r = userWorkflowsRequest(5, { ...base, workflowIds });
      expect(r.kind).toBe('ids');
      expect(new URL(r.url, 'http://x').searchParams.get('ids')).toBe(workflowIds);
    }
  );

  it('pages the history only when no filter is given', () => {
    const r = userWorkflowsRequest(5, { ...base, workflowIds: null });
    expect(r.kind).toBe('page');
    expect(new URL(r.url, 'http://x').searchParams.has('ids')).toBe(false);
  });
});

describe('workflowIdsParam', () => {
  it('keeps every value of a repeated param', () => {
    expect(workflowIdsParam(new URLSearchParams('workflows=a,b&workflows=c'))).toBe('a,b,c');
  });

  it('is null without the param and "" for an empty one', () => {
    expect(workflowIdsParam(new URLSearchParams('q=5'))).toBeNull();
    expect(workflowIdsParam(new URLSearchParams('workflows='))).toBe('');
  });
});
