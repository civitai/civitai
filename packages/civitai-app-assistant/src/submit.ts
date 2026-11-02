import { letStepCallsReachGate, type AssistantTool, type ToolResult } from './tool';

/**
 * Offers the user a Submit for review button. The tool submits nothing: the page sends the app to the
 * moderator review queue, as the user, only when they press that button.
 */
export const SUBMIT_FOR_REVIEW = 'submit_for_review';

/** What a `submit_for_review` call that passed the gate returns; the page shows the button for it. */
export interface SubmitOffer {
  awaitsUser: true;
  /** This offer's id, per gate: an offer restored from an earlier visit never matches the page's. */
  submit: string;
  note: string;
}

/** The offer a finished call made, or null: refused, failed, a subagent's, or another tool. */
export function submitOfferOf({
  name,
  output,
  isError,
  refused,
  stopped,
  subagent,
}: ToolResult): string | null {
  if (name !== SUBMIT_FOR_REVIEW || isError || refused !== undefined || stopped) return null;
  if (subagent !== undefined) return null;
  const offer = output as Partial<SubmitOffer> | null | undefined;
  return offer?.awaitsUser === true && typeof offer.submit === 'string' ? offer.submit : null;
}

/**
 * `submit_for_review`, refused (by `refusal`) on exactly what refuses report_ready: the app must have
 * passed the preview check, the tests and the typecheck since its last change, with every checklist
 * item done.
 */
export function createSubmitTool({
  refusal,
  nextId,
}: {
  /** Why the app may not be offered for review now; null when it may. */
  refusal: () => string | null | Promise<string | null>;
  nextId: () => string;
}): AssistantTool {
  return {
    description:
      'Offer to send the open app to Civitai’s moderators for review, so it can go in the App Store. Call it only when the user asks to submit or publish the app, on its own in its step. It is refused until the app passes what report_ready checks; do what a refusal says, then call it again. It submits nothing: the user sees the app’s name and version with a Submit for review button, and only their press sends it.',
    activity: 'Getting your app ready to submit…',
    inputSchema: { properties: {} },
    async execute() {
      await letStepCallsReachGate();
      const refused = await refusal();
      if (refused) throw new Error(refused);
      const offer: SubmitOffer = {
        awaitsUser: true,
        submit: nextId(),
        note: 'The user now sees the app’s name and version with a Submit for review button. Tell them in one short sentence to press it to send the app to moderator review; nothing is sent until they do, and it goes live only once a moderator approves it. Your reply ends here.',
      };
      return offer;
    },
  };
}
