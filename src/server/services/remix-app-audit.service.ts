import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import {
  auditAppBlockPrompt,
  PASS_THROUGH_AUDIT_TEXT_MAX,
} from '~/server/services/blocks/pass-through-prompt-audit';
import { remixSourceLiterals } from '~/server/services/remix-app-literals';

export const REMIX_SOURCE_UNREADABLE = 'This code could not be read as a JavaScript module';

/**
 * The author's fixed prompt text, audited as the author: every literal piece of a `prompt` given
 * to `ctx.workflow` or `ctx.ask`, in one classifier call. A block refuses the save and counts
 * against the author, as on the generator.
 */
export async function auditRemixAppSource({
  source,
  authorId,
  blockId,
  isGreen,
}: {
  source: string;
  authorId: number;
  blockId: string;
  isGreen: boolean;
}) {
  const literals = remixSourceLiterals(source);
  if (!literals) throw new TRPCError({ code: 'BAD_REQUEST', message: REMIX_SOURCE_UNREADABLE });
  const prompt = literals.prompts.join('\n');
  if (prompt.length > PASS_THROUGH_AUDIT_TEXT_MAX)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `This app's prompts are longer than the ${PASS_THROUGH_AUDIT_TEXT_MAX}-character moderation limit`,
    });
  if (!prompt.trim()) return;
  // The author's own row, not a session: whoever calls this, the audit is the author's.
  const author = await dbRead.user.findUnique({
    where: { id: authorId },
    select: { isModerator: true },
  });
  await auditAppBlockPrompt(
    {
      prompt,
      userId: authorId,
      isGreen,
      isModerator: !!author?.isModerator,
      appBlockId: blockId,
      stepType: 'remix-app-source',
    },
    { refuseUnconfigured: true }
  );
}
