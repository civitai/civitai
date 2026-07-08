import { createSpokeGuard } from '@civitai/auth';

// The door gate is any authenticated user (plan §1) — member-only capabilities are gated per-action in
// $lib/server/membership.ts, not here, so non-members can still browse the Studio.
export const guard = createSpokeGuard({ require: (user) => !!user });
