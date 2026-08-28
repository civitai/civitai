/**
 * The single rule for "may this `Image.url` be handed to our media store as an object key?".
 *
 * 🔴 It lives here because it was open-coded twice, by OPPOSITE construction, and the two answers
 * disagreed on real rows. One spelling asked "does it carry a URI scheme?" and probed everything
 * else; the other asked "is it a bare uuid?" and probed only that. For `some-file.png` the first
 * probes, gets a 404, and PERMANENTLY refuses a moderator publish; the second never asks. A
 * predicate open-coded at two call sites regenerates the same bug at both, so there is one copy and
 * both call sites import it.
 *
 * 🔴 THE OBVIOUS JUSTIFICATION FOR THIS TEST IS FALSE, AND THAT MATTERS FOR HOW IT IS READ.
 * It is NOT true that every legitimate bucket key in `Image.url` is a uuid. Every key-MINTING site
 * is a bare `crypto.randomUUID()` with no prefix and no extension — `src/pages/api/v1/image-upload/
 * index.ts`, `.../multipart/index.ts`, `uploadImageBufferToStore` in `src/utils/s3-utils.ts`, the
 * orchestrator poll/polyGen handlers, the app-listing asset service and the comics router's own
 * upload paths — but several WRITE paths accept a caller-supplied string and never check its shape:
 * seven `comics.router.ts` call sites validate the url with `z.string().min(1)`, and the article
 * `edge-media` sync (`article-content-cleanup.service.ts`) copies the attribute verbatim from
 * sanitized HTML, where the sanitizer does not filter a custom attribute named `url`. Any of those
 * can put `foo/uuid`, `photo.jpg` or `12345` into the column.
 *
 * So this is a deliberate UNDER-approximation: it matches the shape our upload endpoints issue, and
 * classifies everything else as "not something to ask this bucket about". The direction is chosen
 * from what each error COSTS, not from what is most accurate:
 *
 *   - a false NEGATIVE (a real key we decline to probe) costs a detection we would otherwise have
 *     made — the caller falls back to whatever it did before the check existed;
 *   - a false POSITIVE (a non-key we probe) costs a 404 that is indistinguishable from a genuine
 *     miss, and the acting call site turns that into a PERMANENT, un-overridable refusal to publish
 *     an image that may render fine.
 *
 * The heterogeneous, unvalidated population above is exactly where a 404 against our bucket is not
 * evidence of loss, so it must not be probed by a check whose `absent` verdict enforces anything.
 *
 * Relation to the write validators: this is strictly BROADER than zod's `.uuid()` (it accepts an
 * invalid version nibble), so every value `imageSchema`/`addPostImageSchema` admits as a key passes
 * here. That is the sound direction — the guard never declines a key the schema called a key.
 *
 * A url carrying a URI scheme (`http:`, `https:`, `blob:`, `data:`) fails this test for free: none
 * of them is a uuid. That is intentional and is why the older scheme-negative spelling was dropped
 * rather than kept alongside — its complement swept in every legacy oddball above.
 */
const MEDIA_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProbeableMediaKey(url: unknown): url is string {
  return typeof url === 'string' && MEDIA_KEY_RE.test(url);
}
