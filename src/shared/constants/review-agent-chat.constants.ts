/**
 * The App Blocks review agent chat: the `<civitai-chat>` element on the review page, backed by the
 * moderator-only streaming endpoint `/api/mod/apps/review-agent/v1/chat/completions`.
 *
 * Client-safe (no server imports): the page and the endpoint both read these, so the URL, the
 * headers and the model id the element sends are spelled once.
 */

/** The element's `backend.url`. Replies are `POST ${url}/v1/chat/completions`. */
export const REVIEW_AGENT_CHAT_URL = '/api/mod/apps/review-agent';

/**
 * The model id the element sends. It is an alias the endpoint maps to the real model
 * (`REVIEW_AGENT_CHAT_MODELS` in the chat service), so the page never names a provider model and
 * the endpoint refuses every other id.
 */
export const REVIEW_AGENT_CHAT_MODEL_ID = 'review-agent';

/**
 * The publish request (and report) a chat is about. Sent as headers by the element's `fetch`, so
 * the endpoint knows what to authorize and ground on without the model, or the request body,
 * being able to name another one. A custom header also makes any cross-origin request a CORS
 * preflight, which this endpoint never answers.
 */
export const REVIEW_AGENT_CHAT_HEADERS = {
  publishRequestId: 'x-review-publish-request-id',
  reportId: 'x-review-report-id',
} as const;

/**
 * Makes model text unable to become HTML in the chat: a zero-width space goes after every `<`, so
 * no tag, comment or autolink can start, and the text still reads the same (code included).
 *
 * WHY: the element renders replies with `marked` and then DOMPurify. That drops `<img>`, but it
 * keeps raw HTML DOMPurify allows, including the `background` attribute on a table cell, which the
 * browser fetches. Review replies are derived from an untrusted bundle, so a prompt-injected reply
 * could otherwise make the moderator's browser request a remote URL. Applied by the endpoint to
 * every piece of text it streams, so it holds whatever the page renders with.
 */
export function neutralizeChatMarkup(text: string): string {
  return text.replace(/</g, '<\u200B');
}
