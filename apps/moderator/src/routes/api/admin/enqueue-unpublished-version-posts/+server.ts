import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api-endpoint';
import { enqueueUnpublishedVersionPosts, planEnqueue } from '$lib/server/unpublished-version-posts';

export const POST = defineEndpoint({
  page: '/admin',
  summary:
    "Report other users' published posts made with an unpublished model version or model, one Admin Attention post report each, filed by the system account, for moderator review.",
  input: z.object({
    reasons: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(20)
      .describe('The unpublish reason codes whose versions and models count.'),
    dryRun: z.boolean().default(true).describe('Count only. Pass false to file the reports.'),
    expectedCount: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Required for a real run: the `eligible` a dry run just returned.'),
  }),
  returns:
    '{ dryRun, plan: { eligible, excluded, byReason } } or, for a real run, { reported, plan }. 409 when the count moved.',
  notes: [
    'Changes nothing on any post or image; a report only puts the post in the post reports queue.',
    'A rerun skips every post this job already reported, whatever that report’s status.',
  ],
  handler: async ({ reasons, dryRun, expectedCount }, event) => {
    const user = event.locals.user;
    if (!user) error(401, 'Not signed in.'); // defineEndpoint already refused this; narrows the type
    if (dryRun) return { dryRun: true, plan: await planEnqueue(reasons) };
    if (expectedCount === undefined)
      return json({ error: 'A real run needs expectedCount from a dry run.' }, { status: 400 });

    const result = await enqueueUnpublishedVersionPosts({
      reasons,
      expectedCount,
      moderatorId: user.id,
    });
    if (!result.ok)
      return json(
        {
          error: `Expected ${expectedCount} posts but ${result.plan.eligible} are eligible now. Nothing was filed. Dry-run again.`,
          plan: result.plan,
        },
        { status: 409 }
      );
    return { dryRun: false, reported: result.reported, plan: result.plan };
  },
});
