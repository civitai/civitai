/**
 * XGuard policy-iteration debug endpoint.
 * =============================================================================
 *
 * Hidden testing route guarded by WEBHOOK_TOKEN via `?token=` query param.
 *
 * Submits a synchronous-wait XGuard scan against a single test prompt with
 * optional per-label policy/threshold/action overrides. In prompt mode it
 * ALSO runs the regex-based atomic-label detector (scanner-label-regex.ts)
 * against the positive prompt and returns both XGuard and regex results so
 * test scripts can compare them directly.
 *
 * Usage:
 *   POST /api/testing/xguard-test?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: {
 *     "mode": "prompt" | "text",
 *     "positivePrompt": "...",        // when mode=prompt
 *     "negativePrompt": "...",        // when mode=prompt (optional)
 *     "text": "...",                  // when mode=text
 *     "labels": ["young"],            // restrict which labels to evaluate
 *     "labelOverrides": [             // optional candidate policy overrides
 *       {
 *         "label": "Young",
 *         "action": "Scan",
 *         "threshold": 0.5,
 *         "policy": "- x: Civitai ..."
 *       }
 *     ],
 *     "regexLabels": ["familial"],    // optional: which regex labels to run.
 *                                     //   Default: all labels in SCANNER_LABEL_REGEX.
 *                                     //   Pass [] to skip the regex pass entirely.
 *     "wait": 30                       // seconds to wait for orchestrator
 *   }
 *
 * Response:
 *   {
 *     workflowId, status,
 *     output: XGuardModerationOutput,       // raw model results
 *     regexResults: LabelMatchResult[]      // regex-detector results
 *                                           // (only set when mode=prompt; null otherwise)
 *   }
 *
 * No EM row is written, no audit log entry — pure fire-and-forget against
 * the model, plus a deterministic regex pass that runs locally in-process.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { createXGuardModerationRequest } from '~/server/services/orchestrator/orchestrator.service';
import {
  matchLabels,
  SCANNER_LABEL_REGEX,
  type LabelMatchResult,
} from '~/server/services/scanner-label-regex';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

const labelOverrideSchema = z.object({
  label: z.string().min(1),
  action: z.string().min(1),
  threshold: z.number().min(0).max(1),
  policy: z.string().min(1),
});

const schema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('prompt'),
    positivePrompt: z.string().min(1),
    negativePrompt: z.string().optional(),
    instructions: z.string().optional(),
    labels: z.array(z.string()).optional(),
    labelOverrides: z.array(labelOverrideSchema).optional(),
    regexLabels: z.array(z.string()).optional(),
    wait: z.number().int().min(1).max(120).default(30),
  }),
  z.object({
    mode: z.literal('text'),
    text: z.string().min(1),
    labels: z.array(z.string()).optional(),
    labelOverrides: z.array(labelOverrideSchema).optional(),
    wait: z.number().int().min(1).max(120).default(30),
  }),
]);

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
  }
  const input = parsed.data;

  try {
    const common = {
      labels: input.labels,
      labelOverrides: input.labelOverrides,
      wait: input.wait,
      // Suppress the standard audit-write callback — debug requests shouldn't
      // land in `scanner_label_results` and pollute the production audit log.
      callbackUrl: null as null,
      recordForReview: false,
    };

    // Run the regex matcher in parallel with the XGuard call. Prompt mode only —
    // the regex labels are designed for image-generation prompts; text mode has
    // a different semantic surface and we don't want to leak misleading regex
    // results into text-scan responses.
    let regexResults: LabelMatchResult[] | null = null;
    if (input.mode === 'prompt') {
      const requested =
        input.regexLabels !== undefined ? input.regexLabels : Object.keys(SCANNER_LABEL_REGEX);
      if (requested.length > 0) {
        try {
          regexResults = matchLabels(requested, input.positivePrompt);
        } catch (regexErr) {
          // Surface the typo (unknown label) rather than silently dropping.
          return res.status(400).json({
            error: `regex matcher error: ${(regexErr as Error).message}`,
          });
        }
      } else {
        regexResults = [];
      }
    }

    const result =
      input.mode === 'prompt'
        ? await createXGuardModerationRequest({
            mode: 'prompt',
            positivePrompt: input.positivePrompt,
            negativePrompt: input.negativePrompt,
            instructions: input.instructions,
            ...common,
          })
        : await createXGuardModerationRequest({
            mode: 'text',
            content: input.text,
            ...common,
          });

    if (!result?.id) {
      return res.status(502).json({ error: 'orchestrator did not return a workflow id' });
    }

    // Pull the step output off the (now-completed, since we used wait) workflow.
    const steps = (result as { steps?: Array<Record<string, unknown>> }).steps ?? [];
    const xguardStep = steps.find((s) => s.$type === 'xGuardModeration');
    const output = (xguardStep as { output?: unknown })?.output;

    return res.status(200).json({
      workflowId: result.id,
      status: (result as { status?: string }).status,
      output,
      regexResults,
    });
  } catch (e) {
    const error = e as Error;
    return res.status(500).json({ error: error.message, stack: error.stack });
  }
});
