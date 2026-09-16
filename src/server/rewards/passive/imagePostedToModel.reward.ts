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
    // arrives here WITHOUT `viaAppId` and is paid. The all-time `(toUserId, forId)`
    // cap bounds that to once per `(poster, version)`. See the bound recorded on
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
    // It lives HERE rather than as an `if` around the call site because one
    // predicate on the recipient covers every app-originated caller, present and
    // future, without each of them having to re-spell it.
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
    if (input.viaAppId) return false;

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
   * 🔴 SERVER-DERIVED AT EVERY CALL SITE — it is the verified block token's
   * `appId`, never a client value. The native post path
   * (`post.controller.ts`) omits it, which is what makes its absence mean
   * "a person composed this post in the site's own UI".
   *
   * Carried as the id rather than a boolean so the suppression is legible in a
   * trace and so a future rule that needs to know WHICH app has it.
   */
  viaAppId?: string;
};
