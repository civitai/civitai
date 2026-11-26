# Serving civitai.com/ads.txt from a merging route

**Status:** built in the PR that adds this note (`src/server/services/ads-txt.service.ts`, `src/pages/ads.txt`). Live only once the edge redirect is removed (see Cutover).

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
- Add `ads.txt` to `excludedFiles` in `src/server/middleware/region-middleware-utils.ts` (as `robots.txt`
  is), so a crawler in a
  restricted region gets the file rather than the region-blocked redirect.
- Sources are one list in code (`ADS_TXT_SOURCES`), each `{ name, url, required }`. Adding or dropping a partner is a one-line PR;
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
   - `MANAGERDOMAIN=snigelweb.com` once, from config: the ad stack is the primary seller. The second partner's
     file declares `sparteo.com`; that line is dropped. Revisit when that partner's tag is turned on.
5. Each source's records go under a `# <name>` comment with the fetch time, so a reader can trace a line.

## Caching and failure

- `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`. Crawlers fetch ads.txt about daily,
  and partner changes reach the file within an hour.
- An upstream body is used only if it is a 200, is not HTML and has records. A body with under half the
  records of the stored copy is held back for 24 hours (the stored copy is served meanwhile), then accepted,
  so a truncated response cannot empty a section and a real reduction still lands.
- The last good body for each source is kept in `dbKV` (Postgres), written when it changes and at most every
  6 hours otherwise; the built file is memoized per pod for an hour. A failed or rejected fetch serves that
  copy, labelled in its section comment with the last time the upstream answered.
- If the ad stack's source has never been fetched successfully (cold store and upstream down), the route
  answers 302 to the ad stack's hosted URL, which is today's behavior, instead of a file without it.
- If only the partner's source is missing, or its upstream has been gone for over 7 days, the file is served
  without it. That equals today's file.

## Tests

- Merge: records from two sources, a record present in both appears once under the first.
- Variables: mixed-case `OWNERDOMAIN` from both sources collapses to the configured one; `CONTACT` kept.
- Failure: an upstream 500, a timeout and an HTML 200 each fall back to the last good copy; a body with
  too few records is rejected; the ad stack's source missing with no last good copy gives the 302.
- Host gate: .red keeps the 404.

## Cutover

1. Ship the route. The edge 301 still answers `/ads.txt`, so nothing changes for crawlers.
2. Served check before cutover: the route's output must be reachable at the origin past the edge rule,
   `https://civitai.com/ads.txt?check=1` reaches the origin today (the edge rule does not match it) and
   will be answered by the route.
   Compare its records with the two upstream files (union, no loss).
3. DevOps removes the edge 301 for civitai.com only.
4. Served check after cutover: `curl https://civitai.com/ads.txt` returns 200 `text/plain` with both
   sections, and both partners' platforms report the file as valid.

## Updates afterwards

- None by hand. Both partners update their hosted files, and the route picks the changes up within the
  cache window.
- A new partner is one entry in the source list.
- Lines that belong to no partner, if any are ever needed, go in a static source in the repo.
- The second partner's seller lines are served from the start: they authorize sellers and serve nothing on
  their own.
