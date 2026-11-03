// The main app's `/api/mod/user/membership-extend*` payloads, as the panel and the assistant read them.
// The rules (which subscriptions qualify, the cooldown, the $0 invoice) live in the main app's
// membership-extend.service only; nothing here decides anything.

/** Mirrors `MEMBERSHIP_EXTEND_MAX_DAYS` in the main app; the endpoint enforces it again. */
export const MEMBERSHIP_EXTEND_MAX_DAYS = 31;
export const MEMBERSHIP_EXTEND_REASON_MIN = 10;

export type MembershipExtensionSnapshot = {
  id: string;
  status: string;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  latestInvoiceId: string | null;
};

export type MembershipExtensionPreview = {
  userId: number;
  days: number;
  subscription: MembershipExtensionSnapshot | null;
  /** Any one refuses the extension. */
  problems: string[];
  /** Send back with the extension: a membership that moved since is refused. */
  expectedCurrentPeriodEnd: number | null;
  trialEndIso: string | null;
  mode: 'renewing' | 'cancelling' | null;
};

export type MembershipExtensionResult = {
  /** false: Stripe was written to and a post-check failed. Check Stripe; never retry blind. */
  ok: boolean;
  days: number;
  trialEnd: string | null;
  mode: 'renewing' | 'cancelling';
  before: MembershipExtensionSnapshot;
  after: MembershipExtensionSnapshot | null;
  newInvoiceId: string | null;
  problems: string[];
};
