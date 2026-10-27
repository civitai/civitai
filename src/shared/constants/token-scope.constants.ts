// Re-export shim: the token-scope constants moved to @civitai/auth so the hub (OAuth consent + scope
// validation) and the main app share ONE definition (forking the bitmask/labels would be a latent
// security/correctness bug). Existing call sites import from '~/shared/constants/token-scope.constants'
// unchanged. See docs/auth/oauth-provider-implementation-checklist.md §A.
import { TokenScope, tokenScopeGrid } from '@civitai/auth/token-scope';
import { Flags } from '~/shared/utils/flags';

export * from '@civitai/auth/token-scope';

const gridScopeMask = tokenScopeGrid.reduce<number>(
  (mask, row) =>
    mask |
    ('read' in row ? row.read : 0) |
    ('write' in row ? row.write : 0) |
    ('delete' in row ? row.delete : 0),
  0
);

// Full carries bits with no checkbox (SocialTip). A toggled scope keeps only what the grid shows,
// so a custom scope holds exactly the boxes ticked, and ticking every box is still Full.
export function toggleGridScope(tokenScope: number, flag: number): number {
  const newScope = Flags.toggleFlag(tokenScope, flag) & gridScopeMask;
  return newScope === (TokenScope.Full & gridScopeMask) ? TokenScope.Full : newScope;
}
