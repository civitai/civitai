import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess, denied, requiresGrant } from '$lib/server/access';
import { int4Id, parseForm, userIdSchema } from '$lib/server/query';
import { checkedResolutionReason, resolutionReasonFields } from '$lib/server/resolution-reason';
import { RETIRED_SECTIONS, isSection } from '../sections';
import {
  addUserNote,
  sendModNotification,
  updateUserNote,
} from '$lib/server/moderation-memory.service';
import {
  addSocial,
  BUZZ_TRANSACTION_TYPE_KEYS,
  BUZZ_TYPES,
  bulkCommentAction,
  bulkReviewAction,
  grantCosmetic,
  issueStrike,
  removeCosmetic,
  refundShopPurchase,
  sendBuzz,
  mintMembershipCode,
  revokeMembershipCode,
  grantCreatorScore,
  revokeCreatorScoreGrant,
  setRewardsEligibility,
  deleteAccount,
  deleteAccountHold,
  countReactions,
  removeReactions,
  purgeAllContent,
  removeSocial,
  resolveRestriction,
  setModerationFlag,
  takeBackGrantedBox,
  forceLogout,
  refreshSessionCache,
  resetSubscriptionCaches,
  revokeTimedMute,
  toggleModerator,
  updateUserIdentity,
} from '$lib/server/user-actions.service';
import { resolveUsername } from '$lib/server/user-lookup.service';
import {
  boxGrantFields,
  BoxGrantRefused,
  grantMysteryBoxes,
} from '$lib/server/mystery-box-grant.service';
import { ITEM_HOLDER_BUSY_MESSAGE } from '$lib/server/item-holder-lock';
import { accountEnforcementActions } from '$lib/server/account-actions';
import { sendAsCivitai } from '$lib/server/message-as-civitai';
import { MESSAGE_AS_CIVITAI_MAX_LENGTH } from '$lib/message-as-civitai';
import { MEMBERSHIP_CODE_MAX_MONTHS, MEMBERSHIP_CODE_TIERS } from '$lib/membership-code';
import {
  CREATOR_SCORE_GRANT_LARGE_MAX_AMOUNT,
  CREATOR_SCORE_GRANT_MAX_AMOUNT,
  CREATOR_SCORE_GRANT_REASON_MAX,
  type CreatorScoreGrantResult,
} from '$lib/creator-score-grant';
import { BUZZ_ENTITY_TYPES } from '../enforcement-options';
import { HOLD_UNKNOWN_REFUSAL, LEGAL_HOLD_REFUSAL, type DeleteHold } from '$lib/legal-hold';

// The lookup itself lives in the layout so it survives moving between sections; this only validates
// the slug, so an unknown one 404s rather than rendering the fallback panel.
export const load: PageServerLoad = async ({ params, url, locals, parent }) => {
  // A retired section keeps working: its slug is in tickets and pasted lookup URLs, and 404ing one
  // reads as the account being gone rather than the tab having moved.
  const moved = RETIRED_SECTIONS[params.section];
  if (moved) redirect(307, `/retool/user-lookup/${moved}${url.search}`);
  if (!isSection(params.section)) error(404, 'Unknown section');
  // Only where the Delete account and Purge buttons render, and only for someone who may press one.
  let deleteHold: DeleteHold | null = null;
  if (
    params.section === 'admin' &&
    (locals.grants['user.deleteAccount'] || locals.grants['user.purge'])
  ) {
    const { result } = await parent();
    if (result) deleteHold = await deleteAccountHold(result.identity.id);
  }
  return { section: params.section, deleteHold };
};

const NOTE_MAX = 5000;

// Every action's input is a zod parse, per the app standard.
const accountFail = (message: string) => fail(400, { scope: 'account' as const, error: message });
// Separate from `account`: the only renderer of that scope is the panel on Admin, so an identity
// refusal scoped there is invisible on Basic, where the form actually is.
const identityFail = (message: string) => fail(400, { scope: 'identity' as const, error: message });
const noteFail = (status: number, message: string) =>
  fail(status, { scope: 'notes' as const, error: message });
const socialsFail = (message: string) => fail(400, { scope: 'socials' as const, error: message });
const contentFail = (message: string) => fail(400, { scope: 'content' as const, error: message });
const buzzFail = (message: string) => fail(400, { scope: 'buzz' as const, error: message });
const membershipCodeFail = (message: string) =>
  fail(400, { scope: 'membershipCode' as const, error: message });
const creatorScoreFail = (message: string) =>
  fail(400, { scope: 'creatorScore' as const, error: message });
const shopFail = (message: string) => fail(400, { scope: 'shop' as const, error: message });
const reactionsFail = (message: string) =>
  fail(400, { scope: 'reactions' as const, error: message });
const cosmeticsFail = (message: string) =>
  fail(400, { scope: 'cosmetics' as const, error: message });
const notifyFail = (message: string) => fail(400, { scope: 'notify' as const, error: message });
const messageFail = (message: string) =>
  fail(400, { scope: 'message' as const, error: message });

const noteSchema = z.object({ notes: z.string().trim().min(1).max(NOTE_MAX) });

export const actions: Actions = {
  addNote: async ({ request, locals }) => {
    const author = locals.user.username;
    // Notes are attributed by name; without one there is nothing to record or to authorise edits by.
    if (!author) return noteFail(400, 'Your account has no username to attribute the note to.');

    const input = parseForm(userIdSchema.merge(noteSchema), await request.formData());
    if (typeof input === 'string') return noteFail(400, input);

    await addUserNote({ userId: input.userId, notes: input.notes, author });
    return { success: true };
  },

  editNote: async ({ request, locals }) => {
    const author = locals.user.username;
    if (!author) return noteFail(400, 'Your account has no username.');

    const input = parseForm(
      z.object({ id: z.coerce.number().int().positive() }).merge(noteSchema),
      await request.formData()
    );
    if (typeof input === 'string') return noteFail(400, input);

    // Returns false when the note is not this moderator's — the update is scoped by author in SQL, so
    // a forged id changes nothing.
    const updated = await updateUserNote({ id: input.id, notes: input.notes, author });
    if (!updated) return noteFail(403, 'You can only edit your own notes.');
    return { success: true };
  },

  // ENFORCEMENT. Every action below is gated on `/users` or on a named grant, never on this page: reaching User Lookup
  // is an investigation permission, acting on an account is a different one.
  // Ban, mute, timed mute and clearing profile text are shared with the user report queue.
  ...accountEnforcementActions,

  // Ruling on a Pending system restriction, which the mute toggle above cannot do: it clears `muted`
  // and leaves the row Pending, the subscription cancelled and the user untold.
  resolveRestriction: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({
        userRestrictionId: z.coerce.number().int().positive(),
        status: z.enum(['Overturned', 'Upheld']),
        resolvedMessage: z.string().trim().max(1000).optional(),
        ...resolutionReasonFields,
      }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);
    const reason = checkedResolutionReason('restriction', input.status, input);
    if (typeof reason === 'string') return accountFail(reason);

    const result = await resolveRestriction({
      userRestrictionId: input.userRestrictionId,
      status: input.status,
      resolvedMessage: input.resolvedMessage || undefined,
      ...reason,
      userId: input.userId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  // Retool's Enable Edits form. The endpoint gates this on the `retoolUpdateIdentity` permission, so a
  // moderator without it gets a clear refusal from the API rather than a silent no-op — but that is the
  // other app's permission, not ours, so the local capability is what decides who sees the form at all.
  updateIdentity: requiresGrant('user.identity.edit', async ({ request, locals }) => {
    const input = parseForm(
      userIdSchema.extend({
        username: z.string().trim().min(1).max(50).optional(),
        email: z.string().trim().email().max(255).optional(),
        name: z.string().trim().max(255).optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return identityFail(input);

    const result = await updateUserIdentity({
      userId: input.userId,
      username: input.username,
      email: input.email,
      name: input.name,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return identityFail(result.error);
    return { success: true };
  }),

  toggleModerator: requiresGrant('user.moderator.toggle', async ({ request, locals }) => {
    const input = parseForm(
      userIdSchema.extend({ isModerator: z.enum(['true', 'false']) }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);
    // The endpoint's own self-action guard compares against the API KEY's owner, not the moderator
    // clicking — so it does not fire here, and without this a moderator could promote themselves.
    if (input.userId === locals.user.id)
      return accountFail('You cannot change your own moderator status.');

    const result = await toggleModerator({
      userId: input.userId,
      isModerator: input.isModerator === 'true',
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  }),

  forceLogout: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(userIdSchema, await request.formData());
    if (typeof input === 'string') return accountFail(input);

    const result = await forceLogout({ userId: input.userId, moderatorId: locals.user.id });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  removeSocial: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return socialsFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({ id: z.coerce.number().int().positive() }),
      await request.formData()
    );
    if (typeof input === 'string') return socialsFail(input);

    const result = await removeSocial({
      id: input.id,
      userId: input.userId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return socialsFail(result.error);
    return { success: true };
  },

  addSocial: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return socialsFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({
        // http(s) only: the panel renders these as links, and a `javascript:` url would execute in
        // the next moderator's session.
        url: z
          .string()
          .trim()
          .max(1000)
          .regex(/^https?:\/\//i, 'Link must start with http:// or https://'),
        type: z.enum(['Sponsorship', 'Social', 'Other']),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return socialsFail(input);

    const result = await addSocial({
      userId: input.userId,
      url: input.url,
      type: input.type,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return socialsFail(result.error);
    return { success: true };
  },

  // Issuing a strike NOTIFIES the user, so it is gated on the `user.strike` action grant — the one every
  // page that strikes checks — rather than the note permission it sits beside.
  addStrike: async ({ request, locals }) => {
    if (!locals.grants['user.strike']) return noteFail(403, denied('user.strike'));
    const author = locals.user.username;
    if (!author) return noteFail(400, 'Your account has no username to attribute the strike to.');

    const input = parseForm(
      userIdSchema.extend({ reason: z.string().trim().min(1).max(1000) }),
      await request.formData()
    );
    if (typeof input === 'string') return noteFail(400, input);

    // Writes the MAIN APP's strike system, not the moderator database's legacy table — the legacy one
    // gets no escalation, points, expiry, notification or void path. See issueStrike.
    const result = await issueStrike({
      userId: input.userId,
      description: input.reason,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return noteFail(400, result.error);
    // No "could not notify" branch any more: the typed `strike-issued` notification and its email are
    // sent by `createStrike` inside the same call, so there is no separate step here to half-fail.
    return { success: true };
  },

  setModerationFlag: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return noteFail(403, 'Not permitted.');
    const author = locals.user.username;
    if (!author) return noteFail(400, 'Your account has no username.');

    const input = parseForm(
      userIdSchema.extend({
        flag: z.enum(['spamWhitelist', 'deservedMute']),
        value: z.enum(['true', 'false']),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return noteFail(400, input);

    const result = await setModerationFlag({
      userId: input.userId,
      flag: input.flag,
      value: input.value === 'true',
      author,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return noteFail(400, result.error);
    return { success: true };
  },

  // Cache and session refresh are recoverable and touch no content, so they are gated on the same
  // action permission as the rest but carry no confirmation step.
  resetCaches: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(userIdSchema, await request.formData());
    if (typeof input === 'string') return accountFail(input);

    const result = await resetSubscriptionCaches({
      userId: input.userId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  refreshSession: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(userIdSchema, await request.formData());
    if (typeof input === 'string') return accountFail(input);

    const result = await refreshSessionCache({
      userId: input.userId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  // Notifying a user is an enforcement-adjacent act, not a note, so it takes the strike's grant, as the
  // report queues' Notify does.
  sendNotification: async ({ request, locals }) => {
    if (!locals.grants['user.strike']) return notifyFail(denied('user.strike'));
    const input = parseForm(
      userIdSchema.extend({
        message: z.string().trim().min(1).max(1000),
        // Relative paths and absolute civitai URLs only: this renders as a click-through in the user's
        // notification tray, so an arbitrary URL here is a moderator-authored redirect to anywhere.
        url: z
          .string()
          .trim()
          .max(300)
          .refine(
            (v) =>
              v === '' ||
              v.startsWith('/') ||
              /^https:\/\/[a-z0-9.-]*civitai\.(com|red)\//i.test(v),
            {
              message: 'Link must be a relative path or a civitai URL.',
            }
          )
          .optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return notifyFail(input);

    const result = await sendModNotification({
      userId: input.userId,
      message: input.message,
      url: input.url || undefined,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return notifyFail(result.error);
    return { success: true };
  },

  messageAsCivitai: requiresGrant('user.message.asCivitai', async ({ request }) => {
    const input = parseForm(
      userIdSchema.extend({
        message: z.string().trim().min(1).max(MESSAGE_AS_CIVITAI_MAX_LENGTH),
        idempotencyKey: z.string().min(8).max(128),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return messageFail(input);
    const result = await sendAsCivitai(input);
    if (!result.ok) return messageFail(result.error);
    return { success: true, chatId: result.value.chatId };
  }),

  refundPurchase: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return shopFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({ buzzTransactionId: z.string().trim().min(1).max(200) }),
      await request.formData()
    );
    if (typeof input === 'string') return shopFail(input);

    const result = await refundShopPurchase({
      userId: input.userId,
      buzzTransactionId: input.buzzTransactionId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return shopFail(result.error);
    return { success: true, warning: result.warning };
  },

  grantCosmetic: requiresGrant('user.cosmetics.grant', async ({ request, locals }) => {
    const input = parseForm(
      userIdSchema.extend({ cosmeticId: z.coerce.number().int().positive() }),
      await request.formData()
    );
    if (typeof input === 'string') return shopFail(input);

    const result = await grantCosmetic({
      userId: input.userId,
      cosmeticId: input.cosmeticId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return shopFail(result.error);
    return { success: true };
  }),

  grantBox: requiresGrant('items.boxes.grant', async ({ request, locals }) => {
    const input = parseForm(
      userIdSchema.extend({ boxId: int4Id, ...boxGrantFields }),
      await request.formData()
    );
    if (typeof input === 'string') return shopFail(input);

    try {
      const result = await grantMysteryBoxes({
        boxId: input.boxId,
        userIds: [input.userId],
        count: input.count,
        grantId: input.grantId,
        moderatorId: locals.user.id,
      });
      if (result.busyUserIds.length) return shopFail(ITEM_HOLDER_BUSY_MESSAGE);
      if (result.failedUserIds.length)
        return shopFail('The grant failed. Nothing was given; try again.');
      if (result.alreadyGrantedUserIds.length)
        return shopFail('This grant was already made. Reload to grant again.');
      return { success: true };
    } catch (e) {
      if (e instanceof BoxGrantRefused) return shopFail(e.message);
      throw e;
    }
  }),

  takeBackGrantedBox: requiresGrant('items.boxes.grant', async ({ request, locals }) => {
    const input = parseForm(
      userIdSchema.extend({ sourceKey: z.string().trim().min(1).max(200) }),
      await request.formData()
    );
    if (typeof input === 'string') return shopFail(input);

    const result = await takeBackGrantedBox({
      userId: input.userId,
      sourceKey: input.sourceKey,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return shopFail(result.error);
    return { success: true, warning: result.warning };
  }),

  removeCosmetic: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return cosmeticsFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({
        cosmeticId: z.coerce.number().int().positive(),
        claimKey: z.string().trim().min(1).max(200),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return cosmeticsFail(input);

    const result = await removeCosmetic({
      userId: input.userId,
      cosmeticId: input.cosmeticId,
      claimKey: input.claimKey,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return cosmeticsFail(result.error);
    return { success: true, warning: result.warning };
  },

  sendBuzz: requiresGrant('user.buzz.send', async ({ request, locals }) => {
    const input = parseForm(
      userIdSchema.extend({
        amount: z.coerce.number().int().positive().max(1_000_000),
        buzzType: z.enum(BUZZ_TYPES),
        action: z.enum(['send', 'deduct']),
        // NOT `.catch()`: silently substituting a default would file a chargeback as a compensation
        // in the ledger. Retool made Reason a required field.
        transactionType: z.enum(BUZZ_TRANSACTION_TYPE_KEYS),
        description: z.string().trim().min(1).max(500),
        entityType: z
          .enum(BUZZ_ENTITY_TYPES)
          .optional()
          .or(z.literal('').transform(() => undefined)),
        // An always-rendered empty input arrives as `''`, which `.optional()` does NOT skip — it
        // coerces to 0 and fails `.positive()`, so leaving the optional field blank (the normal case)
        // rejected every transaction with an error that read like the amount was wrong.
        entityId: z
          .literal('')
          .transform(() => undefined)
          .or(z.coerce.number().int().positive().max(2_147_483_647))
          .optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return buzzFail(input);
    // Half a link is worse than none: the ledger row would claim an entity type with no id behind it.
    if ((input.entityType === undefined) !== (input.entityId === undefined))
      return buzzFail('EntityType and EntityId must be given together.');

    const result = await sendBuzz({
      userId: input.userId,
      amount: input.amount,
      buzzType: input.buzzType,
      action: input.action,
      transactionType: input.transactionType,
      description: input.description,
      entityType: input.entityType || undefined,
      entityId: input.entityId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return buzzFail(result.error);
    // The parsed input, not the raw form: the confirmation the panel shows has to name what was
    // actually filed. An echo of the typed fields would still read 'sent' for a request the server
    // coerced differently.
    return {
      success: true,
      filed: {
        action: input.action,
        amount: input.amount,
        buzzType: input.buzzType,
        transactionType: input.transactionType,
      },
    };
  }),

  // Bounds are enforced again by the endpoint; these only turn a bad form into a readable refusal.
  mintMembershipCode: requiresGrant('user.membership.code', async ({ request }) => {
    const input = parseForm(
      userIdSchema.extend({
        tier: z.enum(MEMBERSHIP_CODE_TIERS),
        months: z.coerce.number().int().min(1).max(MEMBERSHIP_CODE_MAX_MONTHS),
        reason: z.string().trim().min(1).max(500),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return membershipCodeFail(input);

    const result = await mintMembershipCode(input);
    if (!result.ok) return membershipCodeFail(result.error);
    return {
      success: true,
      minted: {
        code: result.code,
        expiresAt: result.expiresAt,
        tier: input.tier,
        months: input.months,
      },
    };
  }),

  revokeMembershipCode: requiresGrant('user.membership.code', async ({ request }) => {
    const input = parseForm(
      userIdSchema.extend({ code: z.string().regex(/^MB-[A-Z0-9]{4}-[A-Z0-9]{4}$/) }),
      await request.formData()
    );
    if (typeof input === 'string') return membershipCodeFail(input);

    const result = await revokeMembershipCode(input);
    if (!result.ok) return membershipCodeFail(result.error);
    return { success: true, revoked: input.code };
  }),

  grantCreatorScore: requiresGrant('user.creatorScore.grant', async ({ request, locals }) => {
    const maxAmount = locals.grants['user.creatorScore.grantLarge']
      ? CREATOR_SCORE_GRANT_LARGE_MAX_AMOUNT
      : CREATOR_SCORE_GRANT_MAX_AMOUNT;
    const input = parseForm(
      userIdSchema.extend({
        amount: z.coerce.number().int().min(1).max(maxAmount),
        reason: z.string().trim().min(1).max(CREATOR_SCORE_GRANT_REASON_MAX),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return creatorScoreFail(input);

    const result = await grantCreatorScore(input);
    if (!result.ok) return creatorScoreFail(result.error);
    const outcome: CreatorScoreGrantResult = {
      kind: 'granted',
      amount: input.amount,
      total: result.total,
    };
    return { success: true, outcome };
  }),

  revokeCreatorScoreGrant: requiresGrant('user.creatorScore.grant', async ({ request }) => {
    const input = parseForm(
      userIdSchema.extend({
        grantId: z.coerce.number().int().positive(),
        reason: z.string().trim().min(1).max(CREATOR_SCORE_GRANT_REASON_MAX),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return creatorScoreFail(input);

    const result = await revokeCreatorScoreGrant(input);
    if (!result.ok) return creatorScoreFail(result.error);
    const outcome: CreatorScoreGrantResult = { kind: 'revoked', total: result.total };
    return { success: true, outcome };
  }),

  // Scoped to `account`, not `buzz`: the buttons live in the Admin section's action panel, and a
  // failure scoped elsewhere renders on no section the moderator is looking at.
  setRewardsEligibility: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({ eligibility: z.enum(['Eligible', 'Ineligible', 'Protected']) }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    const result = await setRewardsEligibility({
      userId: input.userId,
      eligibility: input.eligibility,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  // Checkbox ids arrive as repeated fields, so they are read off the raw FormData rather than the
  // parsed object, which keeps only the last value per name.
  contentAction: requiresGrant('user.comments.bulk', async ({ request, locals }) => {
    const form = await request.formData();
    const input = parseForm(
      userIdSchema.extend({
        kind: z.enum(['comments', 'reviews']),
        op: z.enum(['delete', 'tos', 'untos', 'exclude', 'include']),
      }),
      form
    );
    if (typeof input === 'string') return contentFail(input);

    const ids = (name: string) =>
      form
        .getAll(name)
        .map((v) => Number(v))
        .filter((n) => Number.isInteger(n) && n > 0);

    if (input.kind === 'comments') {
      if (input.op !== 'delete' && input.op !== 'tos' && input.op !== 'untos')
        return contentFail('Unsupported action for comments.');
      const commentIds = ids('commentIds');
      const commentV2Ids = ids('commentV2Ids');
      const result = await bulkCommentAction({
        action:
          input.op === 'delete'
            ? 'bulkDelete'
            : input.op === 'tos'
            ? 'removeAsTos'
            : 'restoreFromTos',
        commentIds,
        commentV2Ids,
        userId: input.userId,
        moderatorId: locals.user.id,
      });
      if (!result.ok) return contentFail(result.error);
      return {
        success: true,
        op: input.op,
        affected: result.affected ?? 0,
        retainedHidden: result.retainedHidden ?? 0,
        requested: commentIds.length + commentV2Ids.length,
      };
    }

    if (input.op === 'tos' || input.op === 'untos')
      return contentFail('Unsupported action for reviews.');
    const result = await bulkReviewAction({
      action: input.op === 'delete' ? 'delete' : 'setExclude',
      reviewIds: ids('reviewIds'),
      exclude: input.op === 'exclude',
      userId: input.userId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return contentFail(result.error);
    return { success: true };
  }),

  // The typed-username confirmation is checked SERVER-side as well as in the UI: this is irreversible,
  // and a client-only guard is no guard at all against a double-submit or a forged post.
  purgeContent: requiresGrant('user.purge', async ({ request, locals }) => {
    const input = parseForm(
      userIdSchema.extend({ confirm: z.string().trim() }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    const user = await resolveUsername(input.userId);
    if (!user) return accountFail('User not found.');
    if (input.confirm !== (user.username ?? String(input.userId)))
      return accountFail('Type the username exactly to confirm the purge.');

    const result = await purgeAllContent({ userId: input.userId, moderatorId: locals.user.id });
    if (!result.ok) return accountFail(result.error);
    return { success: true, warning: result.warning };
  }),

  // No confirmation check here: the endpoint owns it, and a second copy would drift from it.
  deleteAccount: requiresGrant('user.deleteAccount', async ({ request }) => {
    const input = parseForm(
      userIdSchema.extend({
        username: z.string().optional(),
        removeModels: z.enum(['true', 'false']).optional(),
        removeImages: z.enum(['true', 'false']).optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);
    // The endpoint refuses a held account too; this answers before anything is sent.
    const hold = await deleteAccountHold(input.userId);
    if (hold === 'held') return accountFail(LEGAL_HOLD_REFUSAL);
    if (hold !== 'clear') return accountFail(HOLD_UNKNOWN_REFUSAL);

    const flag = (v: 'true' | 'false' | undefined) => (v === undefined ? undefined : v === 'true');
    const result = await deleteAccount({
      userId: input.userId,
      username: input.username,
      removeModels: flag(input.removeModels),
      removeImages: flag(input.removeImages),
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  }),

  countReactions: requiresGrant('user.removeReactions', async ({ request }) => {
    const input = parseForm(userIdSchema, await request.formData());
    if (typeof input === 'string') return reactionsFail(input);
    const result = await countReactions(input.userId);
    if (!result.ok) return reactionsFail(result.error);
    return { success: true, reactionCounts: result.counts };
  }),

  // The username confirmation is the endpoint's, as on deleteAccount.
  removeReactions: requiresGrant('user.removeReactions', async ({ request }) => {
    const input = parseForm(
      userIdSchema.extend({ username: z.string().optional() }),
      await request.formData()
    );
    if (typeof input === 'string') return reactionsFail(input);
    const result = await removeReactions(input);
    if (!result.ok) return reactionsFail(result.error);
    return {
      success: true,
      reactionsRemoved: result.removed,
      reactionsRemaining: result.remaining,
    };
  }),

  // No mute id any more: the mute lives on the account, so the account id is the whole scope. The old
  // id + userId pair existed to stop one account's side-table row unmuting another.
  revokeTimedMute: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(userIdSchema, await request.formData());
    if (typeof input === 'string') return accountFail(input);

    const result = await revokeTimedMute({
      userId: input.userId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },
};
