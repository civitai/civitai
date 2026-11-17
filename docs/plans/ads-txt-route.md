# Serving civitai.com/ads.txt from a merging route

Status: design, not built. Decisions marked **Decide** need an owner before the build.

## Today

- `https://civitai.com/ads.txt` is answered at the edge with a 301 to the ad stack's hosted file,
  `https://cdn.snigelweb.com/adengine/civitai.com/ads.txt` (about 900 lines). Nothing in this repo
  serves `/ads.txt`, and the redirect is configured outside it.
- `https://civitai.red/ads.txt` returns the site's HTML 404 page. .red has no ads.txt.
- A second ad partner (Sparteo, via its Actirise platform) publishes a hosted file for civitai.com at
  `https://gateway.actirise.com/services/adstxt/<website uuid>`. It is served as `text/plain` today,
  without any activation on our side, and is maintained by the partner.
- A redirect can point at one file only, so adding the second partner means serving a file ourselves.

## Goal

Serve one ads.txt for civitai.com that is the union of every partner's hosted file, kept current with
no hand edits, and that never serves something worse than today's file.

## Route

- `src/pages/ads.txt/index.tsx` with `getServerSideProps`, the same shape as `src/pages/robots.txt`,
  answering through `respondWithText` (`text/plain; charset=utf-8`).
- Host gate with `getRequestDomainColor`: green (civitai.com) serves the merged file; every other
  color keeps today's 404, so .red is unchanged.
- Add `ads.txt` to `excludedFiles` and `regionMiddlewareMatcher` in
  `src/server/middleware/region-middleware-utils.ts` (as `robots.txt` is), so a crawler in a
  restricted region gets the file rather than the region-blocked redirect.
- Sources are one list in code, each `{ name, url }`. Adding or dropping a partner is a one-line PR;
  nobody edits partner lines.

## Merge

1. Fetch each source (timeout 5 s, `text/plain` expected).
2. Parse each line as a record (`domain, publisher id, DIRECT|RESELLER[, cert id]`), a variable
   (`KEY=value`) or a comment/blank. Variable keys are matched without case (the ad stack's file uses
   lowercase `ownerdomain=`, the partner's uppercase `OWNERDOMAIN=`).
3. Records: dedupe on lowercased domain + publisher id + relationship. The first source in the list wins,
   so a record both partners carry appears once, under the first.
4. Variables, emitted once in a header we own:
   - `OWNERDOMAIN=civitai.com` once, from config, not from either file. Both files carry this value today.
   - `CONTACT=` lines: keep each distinct value.
   - `MANAGERDOMAIN`: each file names its own manager (`snigelweb.com`, `sparteo.com`). ads.txt 1.1 allows a
     global `MANAGERDOMAIN` plus per-country ones; whether two global values are valid is not verified
     against the spec text yet. **Decide:** which manager to declare, or whether to declare one per country.
5. Each source's records go under a `# <name>` comment with the fetch time, so a reader can trace a line.

## Caching and failure

- `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`. Crawlers fetch ads.txt about daily,
  and partner changes reach the file within an hour.
- An upstream body is accepted only if it is a 200, is not HTML, and parses to at least half of that
  source's last good record count (an error page served with a 200 must not empty a section).
- The last good body for each source is kept in Redis with no TTL. When a fetch fails or is rejected,
  that source's last good body is used and the failure is logged.
- If the ad stack's source has never been fetched successfully (cold Redis and upstream down), the route
  answers 302 to the ad stack's hosted URL, which is today's behavior, instead of a file without it.
- If only the partner's source is missing, the file is served without it. That equals today's file.

## Tests

- Merge: records from two sources, a record present in both appears once under the first.
- Variables: mixed-case `OWNERDOMAIN` from both sources collapses to the configured one; `CONTACT` kept.
- Failure: an upstream 500, a timeout and an HTML 200 each fall back to the last good copy; a body with
  too few records is rejected; the ad stack's source missing with no last good copy gives the 302.
- Host gate: .red keeps the 404.

## Cutover

1. Ship the route. The edge 301 still answers `/ads.txt`, so nothing changes for crawlers.
2. Served check before cutover: the route's output must be reachable at the origin past the edge rule,
   for example through the same handler at `/api/ads-txt` or a host the edge rule does not cover.
   Compare its records with the two upstream files (union, no loss).
3. DevOps removes the edge 301 for civitai.com only.
4. Served check after cutover: `curl https://civitai.com/ads.txt` returns 200 `text/plain` with both
   sections, and both partners' platforms report the file as valid.

## Updates afterwards

- None by hand. Both partners update their hosted files, and the route picks the changes up within the
  cache window.
- A new partner is one entry in the source list.
- Lines that belong to no partner, if any are ever needed, go in a static source in the repo.
- **Decide:** whether the second partner's lines go live before its tag is turned on. Lines in ads.txt
  authorize sellers but serve nothing on their own.
