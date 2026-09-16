import { imagePostedToModelAppSuppressedCounter } from '~/server/prom/client';
import { createBuzzEvent } from '../base.reward';

export const imagePostedToModelReward = createBuzzEvent({
  toAccountType: 'blue',
  type: 'imagePostedToModel',
  description: 'Image posted to a model you own',
  triggerDescription: 'For each user that posts an image to your model',
  awardAmount: 50,
  caps: [
    {
      keyParts: ['toUserId'],
      interval: 'month',
      amount: 50000,
    },
    {
      keyParts: ['toUserId', 'forId'],
      amount: 5000,
    },
  ],
  getTransactionDetails: async (input: ImagePostedToModelEvent, ctx) => {
    if (!input.modelId) {
      return undefined;
    }

    return {
      entityId: input.modelId,
      entityType: 'Model',
    };
  },
  getKey: async (input: ImagePostedToModelEvent, ctx) => {
    // 🔴 A CALL THAT NAMES A COMPOSING APP PAYS THIS REWARD TO NOBODY, AND THIS IS
    // THE ONLY SITE THAT DECIDES IT.
    //
    // ⚠️ READ THAT AS A CLAIM ABOUT THE CALL, NOT ABOUT THE POST. The signal is an
    // argument, not a column: nothing on the `Post` row says an app composed it, so
    // a post created by an app and later republished through `post.controller.ts`
    // arrives here WITHOUT `viaAppId` and is paid. What bounds that to ONE award per
    // `(byUserId, forId)` is the Buzz ledger, NOT the caps above: `sendAward` derives
    // `externalTransactionId` as `${type}:${forId}-${toUserId}-${byUserId}`
    // (`base.reward.ts`), and a repeat of that id comes back as a `conflict` — money
    // already moved — rather than a second grant (`buzz.service.ts`,
    // `createBuzzTransactionMany`). ⚠️ That last step is asserted by THIS repo's
    // comments about an external Buzz service; it has not been probed here. The two
    // `caps` entries are NOT the mechanism — neither is keyed on `byUserId`, so
    // `['toUserId','forId']` bounds the total paid to one owner for one version
    // across ALL posters, not one poster's repeats. See the bound recorded on
    // `applyBlockPostPublishEffects` — do not restate this guard as "an app-composed
    // post never pays".
    //
    // This reward is unlike every other reward on a post path: it is paid to the
    // MODEL OWNER, who is a THIRD PARTY to the post — neither the author nor
    // anyone the author interacted with. The gallery target is supplied by the
    // calling app, so on an app-composed post the recipient is chosen by the app
    // rather than by the person whose byline the post carries.
    //
    // `false` is the framework's per-call suppression signal — `apply` reads it as
    // `if (!definedKey) return null`, so nothing is keyed, nothing is deduped and
    // nothing is paid.
    //
    // It lives HERE rather than as an `if` around the call site so the PREDICATE
    // has one home: a second app-originated caller does not re-implement the rule,
    // and a change to it changes every caller at once.
    //
    // ⚠️ THE PREDICATE IS CENTRALISED; THE SIGNAL IS NOT, AND NOTHING FORCES A NEW
    // CALLER TO SEND IT. `viaAppId` is OPTIONAL below, so a future app-originated
    // caller that simply omits it is PAID — this guard never sees it. The field
    // cannot be made required to close that: the native caller
    // (`post.controller.ts`) must be able to omit it, and its absence is precisely
    // what "a person composed this post in the site's own UI" means here. The one
    // app-originated caller that exists is forced by its OWN signature instead —
    // `applyBlockPostPublishEffects` takes a REQUIRED `appId` and forwards it
    // (`src/server/services/blocks/block-post.service.ts`) — which is a guarantee
    // about that function, not about this field. A new caller has to opt in.
    //
    // 🔴 DELIBERATELY FIRST, BEFORE THE OWNER LOOKUP. A suppressed call must not
    // pay for a `$queryRaw`, and putting it after the self-post guard would make
    // the two share a fixture and stop either being attributable on its own.
    //
    // ⚠️ SCOPE, STATED SO IT IS NOT READ AS WIDER: this suppresses ONLY the
    // third-party model-owner reward. `firstDailyPostReward` is paid to the POST'S
    // AUTHOR and is deliberately UNCHANGED on the app path — see the operator
    // decision recorded on `applyBlockPostPublishEffects`, which this narrows
    // rather than reverses.
    if (input.viaAppId) {
      // 🔴 THE ONLY SIGNAL THIS DECLINE PRODUCES. Everything that would otherwise
      // record it — the ClickHouse `buzzEvents` row, the Redis dedup entry, the
      // award — is downstream of a resolved key, and this returns before all of
      // them. Without this counter neither the frequency of the decline nor the
      // product loss stated on `applyBlockPostPublishEffects` is readable
      // anywhere, and "fix forward if abuse is observed" has nothing behind it.
      //
      // Unlabelled, and an UPPER BOUND rather than the loss itself: this returns
      // before the owner lookup, so some of these calls would have been declined
      // anyway by the `modelOwnerId === posterId` guard below or by an unresolved
      // owner. Times `awardAmount`, it is the most that could have been paid.
      // Optional-chained to match the reward counters in `base.reward.ts` —
      // `getKey` runs synchronously inside a user mutation, so nothing here may
      // throw.
      imagePostedToModelAppSuppressedCounter?.inc?.();
      return false;
    }

    if (!input.modelOwnerId) {
      const [{ userId } = { userId: undefined }] = await ctx.db.$queryRaw<{ userId?: number }[]>`
        SELECT m."userId"
        FROM "ModelVersion" mv
        JOIN "Model" m ON m."id" = mv."modelId"
        WHERE mv.id = ${input.modelVersionId}
      `;
      input.modelOwnerId = userId;
    }
    // No owner resolved (deleted model/version) or self-post → no reward. The destructure default guards
    // against a `[]` result throwing out of this inline reward.
    if (!input.modelOwnerId || input.modelOwnerId === input.posterId) return false;

    return {
      toUserId: input.modelOwnerId,
      forId: input.modelVersionId,
      byUserId: input.posterId,
    };
  },
});

type ImagePostedToModelEvent = {
  modelId?: number;
  modelVersionId: number;
  posterId: number;
  modelOwnerId?: number;
  /**
   * The OAuth client id of the app that composed the post, when one did.
   *
   * 🔴 SERVER-DERIVED WHEREVER IT IS SUPPLIED — it is the verified block token's
   * `appId`, never a client value. Exactly one production call site supplies it
   * (`block-post.service.ts`); the native post path (`post.controller.ts`) omits
   * it, which is what makes its absence mean "a person composed this post in the
   * site's own UI".
   *
   * Carried as the id rather than a boolean so a future rule that needs to know
   * WHICH app has it. ⚠️ It is NOT currently emitted anywhere — the suppression
   * counter beside the guard is deliberately unlabelled — so today the id is
   * available to code, not to a query.
   */
  viaAppId?: string;
};
