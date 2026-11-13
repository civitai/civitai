import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));

import { applyGrants } from '../access';
import { requireWorkspace } from '../text-scan-tests/guard';
import type { Workspace } from '$lib/text-scan-tests/types';

const user = { roles: ['moderator:prompts', 'moderator:rules'] };

beforeEach(() => {
  applyGrants({
    '/text-scan/prompts': ['moderator:prompts'],
    '/text-scan/model-rules': ['moderator:rules'],
  });
});

describe('requireWorkspace', () => {
  it('opens the Prompts workspace', () => {
    expect(() => requireWorkspace(user, 'prompts')).not.toThrow();
  });

  it('treats a set stored under the retired Model rules workspace as not found', () => {
    expect(() => requireWorkspace(user, 'modelRules' as Workspace)).toThrow(
      expect.objectContaining({ status: 404 })
    );
  });
});
