import { error, fail, redirect } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { CAPABILITIES, canAccess, canUse, denied } from '$lib/server/access';
import { parseForm, userIdSchema } from '$lib/server/query';
import { RETIRED_SECTIONS, isSection } from '../sections';
import {
  addUserNote,
  sendModNotification,
  updateUserNote,
} from '$lib/server/moderation-memory.service';
import {
  BAN_REASON_CODES,
  addSocial,
  addTimedMute,
  BUZZ_TRANSACTION_TYPE_KEYS,
  BUZZ_TYPES,
  bulkCommentAction,
  bulkReviewAction,
  grantCosmetic,
  issueStrike,
  removeCosmetic,
  refundShopPurchase,
  sendBuzz,
  setRewardsEligibility,
  clearProfileText,
  purgeAllContent,
  removeSocial,
  resolveRestriction,
  findPaddleCustomerOwner,
  setPaddleCustomer,
  setModerationFlag,
  forceLogout,
  refreshSessionCache,
  resetSubscriptionCaches,
  revokeTimedMute,
  setBanned,
  toggleModerator,
  updateUserIdentity,
  setMuted,
  unmuteAndClearTimed,
} from '$lib/server/user-actions.service';
import { resolveUsername } from '$lib/server/user-lookup.service';
import { BUZZ_ENTITY_TYPES } from '../enforcement-options';
import { PROFILE_FIELD_KEYS, type ProfileField } from '$lib/enforcement';

// The lookup itself lives in the layout so it survives moving between sections; this only validates
// the slug, so an unknown one 404s rather than rendering the fallback panel.
export const load: PageServerLoad = async ({ params, url }) => {
  // A retired section keeps working: its slug is in tickets and pasted lookup URLs, and 404ing one
  // reads as the account being gone rather than the tab having moved.
  const moved = RETIRED_SECTIONS[params.section];
  if (moved) redirect(307, `/retool/user-lookup/${moved}${url.search}`);
  if (!isSection(params.section)) error(404, 'Unknown section');
  return { section: params.section };
};

const NOTE_MAX = 5000;

// Every action's input is a zod parse, per the app standard. `fail` shapes carry the panel scope so each
// panel renders only its own error — see format.ts.
const accountFail = (message: string) => fail(400, { scope: 'account' as const, error: message });
// Separate from `account`: the only renderer of that scope is the panel on Admin, so an identity
// refusal scoped there is invisible on Basic, where the form actually is.
const identityFail = (message: string) => fail(400, { scope: 'identity' as const, error: message });
const noteFail = (status: number, message: string) =>
  fail(status, { scope: 'notes' as const, error: message });
const socialsFail = (message: string) => fail(400, { scope: 'socials' as const, error: message });
const profileFail = (message: string) => fail(400, { scope: 'profile' as const, error: message });
const contentFail = (message: string) => fail(400, { scope: 'content' as const, error: message });
const buzzFail = (message: string) => fail(400, { scope: 'buzz' as const, error: message });
const shopFail = (message: string) => fail(400, { scope: 'shop' as const, error: message });
const cosmeticsFail = (message: string) =>
  fail(400, { scope: 'cosmetics' as const, error: message });
const notifyFail = (message: string) => fail(400, { scope: 'notify' as const, error: message });

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

  // ENFORCEMENT. Every action below is gated on `/users` rather than this page: reaching User Lookup
  // is an investigation permission, acting on an account is a different one.
  setMuted: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({ muted: z.enum(['true', 'false']) }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    // Unmuting closes out any timed mute too. Without it the account is unmuted while the moderator
    // database still holds an active schedule, and the panel shows a Mute button beside a live timed
    // mute — two contradictory statements about the same account.
    const result =
      input.muted === 'true'
        ? await setMuted({ userId: input.userId, muted: true, moderatorId: locals.user.id })
        : await unmuteAndClearTimed({ userId: input.userId, moderatorId: locals.user.id });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  // Retool's Paddle wizard, in one form: submitting an id that another account holds comes back with
  // that account rather than moving it, and the second submit does the move explicitly.
  linkPaddle: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({
        paddleCustomerId: z.string().trim().max(255).optional(),
        takeFrom: z.coerce.number().int().positive().optional(),
        unlink: z.literal('1').optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    if (input.unlink) {
      const cleared = await setPaddleCustomer({
        userId: input.userId,
        paddleCustomerId: null,
        moderatorId: locals.user.id,
      });
      return cleared.ok ? { success: true } : accountFail(cleared.error);
    }

    if (!input.paddleCustomerId) return accountFail('Enter a Paddle customer id.');

    // Checked even when `takeFrom` was sent: the holder can have changed since the page rendered, and
    // the confirmation the moderator gave was about a specific account.
    const owner = await findPaddleCustomerOwner(input.paddleCustomerId);
    if (owner && owner.id !== input.userId && owner.id !== input.takeFrom)
      return fail(409, {
        scope: 'account',
        error: `That customer id is linked to another account.`,
        paddleConflict: { ...owner, paddleCustomerId: input.paddleCustomerId },
      });

    const result = await setPaddleCustomer({
      userId: input.userId,
      paddleCustomerId: input.paddleCustomerId,
      takeFrom: owner?.id === input.takeFrom ? input.takeFrom : undefined,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  // Ruling on a Pending system restriction, which the mute toggle above cannot do: it clears `muted`
  // and leaves the row Pending, the subscription cancelled and the user untold.
  resolveRestriction: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({
        userRestrictionId: z.coerce.number().int().positive(),
        status: z.enum(['Overturned', 'Upheld']),
        resolvedMessage: z.string().trim().max(1000).optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    const result = await resolveRestriction({
      userRestrictionId: input.userRestrictionId,
      status: input.status,
      resolvedMessage: input.resolvedMessage || undefined,
      userId: input.userId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  // Retool's Enable Edits form. The endpoint gates this on the `retoolUpdateIdentity` permission, so a
  // moderator without it gets a clear refusal from the API rather than a silent no-op — but that is the
  // other app's permission, not ours, so the local capability is what decides who sees the form at all.
  updateIdentity: async ({ request, locals }) => {
    if (!canUse(locals.user, CAPABILITIES.editIdentity))
      return identityFail(denied(CAPABILITIES.editIdentity));
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
  },

  toggleModerator: async ({ request, locals }) => {
    if (!canUse(locals.user, CAPABILITIES.toggleModerator))
      return accountFail(denied(CAPABILITIES.toggleModerator));
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
  },

  forceLogout: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(userIdSchema, await request.formData());
    if (typeof input === 'string') return accountFail(input);

    const result = await forceLogout({ userId: input.userId, moderatorId: locals.user.id });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  clearProfileText: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return profileFail('Not permitted.');
    const form = await request.formData();
    const input = parseForm(userIdSchema, form);
    if (typeof input === 'string') return profileFail(input);

    // Checkboxes: absent when unticked, so they are read off the raw FormData rather than the parsed
    // object, which only carries the last value for a repeated name.
    const fields = form
      .getAll('fields')
      .map(String)
      .filter((f): f is ProfileField => (PROFILE_FIELD_KEYS as string[]).includes(f));

    const result = await clearProfileText({
      userId: input.userId,
      fields,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return profileFail(result.error);
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

  // Issuing a strike NOTIFIES the user, so it is gated on the enforcement permission rather than the
  // note permission it sits beside.
  addStrike: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return noteFail(403, 'Not permitted.');
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

  // Notifying a user is an enforcement-adjacent act, not a note, so it takes the same gate.
  sendNotification: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return notifyFail('Not permitted.');
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
    return { success: true };
  },

  grantCosmetic: async ({ request, locals }) => {
    if (!canUse(locals.user, CAPABILITIES.grantCosmetics))
      return shopFail(denied(CAPABILITIES.grantCosmetics));
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
  },

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
    return { success: true };
  },

  sendBuzz: async ({ request, locals }) => {
    // Retool gated the Buzz Transaction pane on the Senior Mod group; gating on /users alone handed a
    // restricted capability to every moderator who could reach the page.
    if (!canUse(locals.user, CAPABILITIES.sendBuzz)) return buzzFail(denied(CAPABILITIES.sendBuzz));
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
    return { success: true };
  },

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
  contentAction: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return contentFail('Not permitted.');
    const form = await request.formData();
    const input = parseForm(
      userIdSchema.extend({
        kind: z.enum(['comments', 'reviews']),
        op: z.enum(['delete', 'tos', 'exclude', 'include']),
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
      if (input.op !== 'delete' && input.op !== 'tos')
        return contentFail('Unsupported action for comments.');
      const result = await bulkCommentAction({
        action: input.op === 'delete' ? 'bulkDelete' : 'removeAsTos',
        commentIds: ids('commentIds'),
        commentV2Ids: ids('commentV2Ids'),
        userId: input.userId,
        moderatorId: locals.user.id,
      });
      if (!result.ok) return contentFail(result.error);
      return { success: true };
    }

    if (input.op === 'tos') return contentFail('Unsupported action for reviews.');
    const result = await bulkReviewAction({
      action: input.op === 'delete' ? 'delete' : 'setExclude',
      reviewIds: ids('reviewIds'),
      exclude: input.op === 'exclude',
      userId: input.userId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return contentFail(result.error);
    return { success: true };
  },

  // The typed-username confirmation is checked SERVER-side as well as in the UI: this is irreversible,
  // and a client-only guard is no guard at all against a double-submit or a forged post.
  purgeContent: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
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
    return { success: true };
  },

  setBanned: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    // reasonCode is validated against the SAME list the main app's endpoint parses. It rejects anything
    // else with a 500 before the ban happens, so an unchecked value here is a ban that silently does not
    // occur.
    const input = parseForm(
      userIdSchema.extend({
        ban: z.enum(['true', 'false']),
        reasonCode: z
          .enum(BAN_REASON_CODES)
          .optional()
          .or(z.literal('').transform(() => undefined)),
        detailsInternal: z.string().trim().max(2000).optional(),
        detailsExternal: z.string().trim().max(2000).optional(),
        removeMedia: z.string().optional(),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    const result = await setBanned({
      userId: input.userId,
      ban: input.ban === 'true',
      reasonCode: input.reasonCode,
      detailsInternal: input.detailsInternal || undefined,
      detailsExternal: input.detailsExternal || undefined,
      removeMedia: input.removeMedia === 'on',
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  addTimedMute: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const author = locals.user.username;
    if (!author) return accountFail('Your account has no username.');

    const input = parseForm(
      userIdSchema.extend({
        hours: z.coerce.number().positive().max(8760),
        reason: z.string().trim().min(1).max(500),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    const until = new Date(Date.now() + input.hours * 3_600_000);
    const result = await addTimedMute({
      userId: input.userId,
      until,
      reason: input.reason,
      author,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },

  revokeTimedMute: async ({ request, locals }) => {
    if (!canAccess(locals.user, '/users')) return accountFail('Not permitted.');
    const input = parseForm(
      userIdSchema.extend({ id: z.coerce.number().int().positive() }),
      await request.formData()
    );
    if (typeof input === 'string') return accountFail(input);

    const result = await revokeTimedMute({
      id: input.id,
      userId: input.userId,
      moderatorId: locals.user.id,
    });
    if (!result.ok) return accountFail(result.error);
    return { success: true };
  },
};
