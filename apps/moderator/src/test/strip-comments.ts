/**
 * The choke point every raw-source test pin goes through.
 *
 * A text pin cannot tell code from a sentence ABOUT the code, so a pin written against raw source
 * passes on its own witness in a comment — and keeps passing after the code it pins is deleted.
 * `feedback-panel-tripwires.test.ts` records three such incidents in `FeedbackDetail.svelte`, each
 * caught a round later than the last, and each originally patched by widening the pinned string
 * with a neighbouring token. That fixes the instance and leaves the class live for whichever pin
 * is written next.
 *
 * Order matters: a markup comment can contain either script-comment syntax, so markup goes first.
 * Over-stripping is the SAFE direction — it makes pins fail LOUDLY — which is why the line-comment
 * rule is allowed to be blunt (it spares `https://` and nothing else).
 */
export const stripComments = (text: string): string =>
  text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:/])\/\/[^\n]*/g, '$1');
