// The main app's `/api/mod/user/membership-extend*` payloads, as the panel and the assistant read them.
// The rules (which subscriptions qualify, the cooldown, the $0 invoice) live in the main app's
// membership-extend.service only.

/** Mirrors `MEMBERSHIP_EXTEND_MAX_DAYS` in the main app; the endpoint enforces it again. */
export const MEMBERSHIP_EXTEND_MAX_DAYS = 31;
export const MEMBERSHIP_EXTEND_REASON_MIN = 10;
/** Mirrors `MEMBERSHIP_EXTEND_COOLDOWN_DAYS` in the main app, for the panel's wording only. */
export const MEMBERSHIP_EXTEND_COOLDOWN_DAYS = 25;

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
  /** true: Stripe took the update. false: it refused it, nothing written. null: no answer. */
  written: boolean | null;
};

// `/api/mod/user/membership-cancel*`: set or undo cancel-at-period-end. Rules live in the main app's
// membership-cancel.service.
export type MembershipCancelPreview = {
  userId: number;
  cancelAtPeriodEnd: boolean;
  subscription: MembershipExtensionSnapshot | null;
  problems: string[];
  /** false: already so, nothing to write. null: refused. */
  changed: boolean | null;
};

export type MembershipCancelResult = {
  ok: boolean;
  cancelAtPeriodEnd: boolean;
  changed: boolean;
  before: MembershipExtensionSnapshot;
  after: MembershipExtensionSnapshot | null;
  problems: string[];
  written: boolean | null;
};

// `/api/mod/user/membership-resync*`: re-read Stripe into CustomerSubscription. Writes nothing to Stripe.
export type MembershipRowView = {
  id: string;
  status: string;
  priceId: string;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  currentPeriodEnd: string | null;
};

export type MembershipResyncChange = {
  field: keyof MembershipRowView;
  ours: string | boolean | null;
  stripe: string | boolean | null;
};

export type BuzzMembershipToEnd = { id: string; status: string; currentPeriodEnd: string | null };

export type MembershipResyncPreview = {
  userId: number;
  ours: MembershipRowView | null;
  stripe: MembershipRowView | null;
  changes: MembershipResyncChange[];
  /** Set: the re-sync ends this Buzz-bought membership, and needs `confirmEndBuzzMembership`. */
  endsBuzzMembership: BuzzMembershipToEnd | null;
  problems: string[];
};

export type MembershipResyncResult = {
  ok: boolean;
  before: MembershipRowView | null;
  after: MembershipRowView | null;
  changes: MembershipResyncChange[];
  endedBuzzMembership: BuzzMembershipToEnd | null;
};
