# content-policy-go: design

One service that answers, for one viewer, the SFW/NSFW and region question every surface asks today
in its own copy of the code: which content ratings may this viewer be sent, at which browsing level,
and does their region hold them to SFW content or refuse them. Callers send who is asking and what the
edge stamped on the request; the service looks up the viewer's own settings and answers.

It starts in **shadow** for one caller, the registry adapter (`src/server/registry-adapter/`): the
adapter keeps deciding exactly as before and compares its answer with the service's. No caller's
decision comes from the service yet (see [Migrating a caller](#migrating-a-caller)).

## The contract

`POST /v1/decide`, a JSON body:

| field     | type             | meaning                                                                                      |
| --------- | ---------------- | -------------------------------------------------------------------------------------------- |
| `context` | string, required | the caller context ([Caller contexts](#caller-contexts)); its rules decide the answer         |
| `userId`  | int, optional    | the viewer's user id; absent: anonymous. Only contexts that read the user look it up          |
| `country` | string, optional | the edge's `cf-ipcountry`, exactly as received; absent or null: the header was not sent      |
| `region`  | string, optional | the edge's `cf-region-code`, exactly as received                                             |
| `isUk`    | string, optional | the edge's `x-isuk`, exactly as received (`true` or `1` makes the country GB, as `getRegion`) |
| `host`    | string, optional | the request's domain color: `green`, `blue`, `red`; absent: no host; anything else: no color  |

Values are passed **as received**: not trimmed, not uppercased. The rules trim and uppercase where
the site does, and only there, and the vectors pin the places they differ (` FR`, `us`, `ß`).

The answer:

| field           | meaning                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `ratings`       | the content ratings the viewer may be sent, from `g`, `pg`, `pg13`, `r`, `x`, `xxx`; empty when refused   |
| `unknownRating` | whether an item with no rating, or one outside the ladder, may be sent                                   |
| `browsingLevel` | the viewer's browsing level (NsfwLevel bits); 0 when refused                                             |
| `regionHold`    | `none`, `restricted` (held to SFW) or `blocked` (held to SFW, or refused: the context says which)         |
| `reason`        | what decided it, the first that applies (below); the `reason` label of the decision metric              |
| `context`       | the context asked                                                                                        |
| `policyVersion` | 12 hex characters naming the policy in force (data file, context rules, region lists); key a cache on it |
| `fallback`      | true when this is the SFW fallback, not a decision about this viewer                                     |
| `error`         | on a fallback, why                                                                                       |

`reason`, in order: `error`, `invalid-input`, `unknown-country`, `region-blocked`,
`region-restricted`, `moderator-bypass`, `host-sfw`, `unrestricted`, `anonymous`, `user-unavailable`,
`user-settings`.

**POST, not GET.** The input names a user and where they are; a query string is written to every
access log on the way, a body is not. Nothing is cacheable by a proxy anyway: the caller keeps the
answer ([Caching](#caching)).

### Fail closed

Every answer that is not a decision is the **SFW fallback** in the same shape: ratings `g`, `pg`,
`pg13`; no unknown rating; browsing level 1 (PG); `regionHold: restricted`; `fallback: true`; and a
status that is not 200:

| status | reason          | when                                                                    |
| ------ | --------------- | ----------------------------------------------------------------------- |
| 400    | `invalid-input` | the body is not one JSON object of the fields above, or a field is bad   |
| 503    | `error`         | the user's settings could not be read within the lookup timeout         |
| 500    | `error`         | anything else (a panic is recovered into this answer)                   |

A caller that reads only the body still gets SFW, and a caller that cannot reach the service at all
must use the same fallback (the registry adapter's shadow counts it as `error` or `timeout`). Nothing
here ever answers "unrestricted" for an error. A user id with no usable user (none, deleted, banned)
is a decision, not an error: it is decided as anonymous, `reason: user-unavailable`.

Input bounds: body 4 KiB, each string field 64 bytes, `userId` 1 to 2³¹−1 (`"User".id` is an int4),
no unknown fields, nothing after the object.

## Caller contexts

Each context is a surface that decides this today. Where the surfaces disagree, the disagreement is a
**named rule** (`internal/policy/contexts.go`), and each context picks its own value, so every caller
keeps its own behaviour and nothing is resolved silently.

| rule              | `registry-subscription`                                  | `site`                                                         | `public-api`                     |
| ----------------- | -------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------- |
| `unknownCountry`  | `hold`: held to SFW                                      | `unrestricted`                                                 | `unrestricted`                   |
| `blockedRegion`   | `hold`: held to SFW                                      | `refuse`                                                       | `refuse`                         |
| `level`           | `viewer`: getServerBrowsingLevel                         | `viewer`                                                       | `api`: all, or SFW when held      |
| `nsfwHost`        | `ignored`: mature-capable whatever the host              | `color`: blue or red, or no host at all                        | `ignored`                        |
| `ratingSurface`   | `unless-held`                                            | `red-host`: isRedCapableHost                                   | `always`                         |
| `unknownRating`   | `closed`: only to a viewer who may read R and X          | `open`: not mature, admitted                                   | `open`                           |
| `moderatorBypass` | no                                                       | yes: a moderator is let past the region restriction            | no                               |
| Node code         | `describeRegion`, `audienceForUser`, `audienceAdmits`     | `getFeatureFlags().canViewNsfw`, `getServerBrowsingLevel`, the `/apps` store gate (`matureRatingsAllowed`) | `apiBrowsingLevel`, `isAPIAccessBlocked` |

`site` is the site's request: its `canViewNsfw` feature, the level it gives, and the `/apps` store's
rating gate on that level. feed-go ports the same tRPC rules (`internal/browsing`); it is not a
caller here, and its two known differences from the site are listed below.

## Divergences found

Measured by the vectors (the generator runs the real functions; each row is pinned there):

1. **Unknown country.** The adapter holds a request with no `cf-ipcountry`, an empty one, `XX`, `T1`
   or anything that is not two letters to SFW (`countryKnown`, fail closed). The site and the API
   serve it unrestricted: `checkRegionAccess` allows a request with no country, and no list names
   one. Rule `unknownCountry`.
2. **Blocked region.** The adapter holds a blocked region to SFW (its protocol has no "not served in
   your region" error); the site shows its block page and the API answers 451. Rule `blockedRegion`.
3. **Host.** The adapter treats the registry as mature-capable whatever the host. The site needs a
   blue or red host for `canViewNsfw`, and a red one for the store's mature ratings. Rules
   `nsfwHost`, `ratingSurface`.
4. **No host on the site.** `hasFeature` skips its server check when the request has no host, so
   `canViewNsfw` is on (the user's own level applies), while `isRedCapableHost(undefined)` is off (no
   mature rating). Part of `nsfwHost: color`. feed-go's `CanViewNsfw` answers false for no host:
   narrower than the site.
5. **Unknown rating.** The adapter fails closed (`audienceAdmits`: only to a viewer who may read R
   and X); the store's `matureRatingAllowed` admits any rating that is not mature. Rule
   `unknownRating`.
6. **XXX in the adapter.** An `Audience` never admits XXX itself (`allowed.xxx` is false, and the
   comment in `audience.ts` says XXX fails closed), but `xxx` is not on the rating ladder, so
   `audienceAdmits` reads it as an unknown rating and admits it to every viewer who may read R and X.
   Measured: `audienceAdmits(audienceForUser({showNsfw: true, browsingLevel: 31}), 'xxx')` is true.
   The service reproduces it (`unknownRating: closed`), and it is reported, not fixed here: changing
   it changes what the adapter streams.
7. **Moderators.** The feature-flag service lets a moderator past the region restriction; the
   adapter does not. Rule `moderatorBypass`.
8. **The API ignores the user.** `apiBrowsingLevel` is every level, or SFW in a restricted region,
   whoever asks. Rule `level: api`.
9. **Trimming.** The adapter's `countryKnown` trims and uppercases the country, but the region lists
   are read untrimmed (`getRegionEffectiveDate`). So ` GB`, `gb\n` or `\u00a0FR` (a leading NBSP) count as a known
   country and match no list: the adapter serves them **unrestricted**, though the trimmed country is
   blocked or restricted. The edge never sends such a value; a `meta` value could, once
   `REGISTRY_ADAPTER_TRUST_META` is on. Reproduced, and reported.
10. **`US` is case-sensitive.** The site judges a US state only when the country is exactly `US`:
    `us` with `NY` is judged as the country `US`. feed-go uppercases first and judges `US:NY`.
11. **Dates.** A rule applies from the END of its date (`${date}T23:59:59.999Z`) everywhere. A date
    that is not a real `YYYY-MM-DD` is handed to `new Date` by the site (`2025-02-30` becomes March
    2; garbage makes a rule that never applies); feed-go and this service refuse to start on it.
12. **Unicode.** The site uppercases with JavaScript's full case mapping (`ß` → `SS`, `ſ` → `S`) and
    trims JavaScript's whitespace set (NBSP and BOM, not NEL). The service does the same
    (`jsUpper`, `jsTrim`); Go's `strings.ToUpper` and `strings.TrimSpace` differ on each.

## Trust model

Every location field is taken from the caller as given. They are trustworthy only when the edge in
front of the original request set them and stripped any a client sent, and only when the caller
passes them on unchanged. So:

- **Only in-cluster callers may reach this service**, each admitted by name by the deployment's
  network policy. It has no public route. A caller that can reach it chooses the viewer's country,
  and so whether they are held to SFW.
- A caller passes the edge's values for the request it is serving, never values a client sent it.
  The registry adapter sends the same values it judges itself (`regionHeaders`: the headers, with
  `meta` applied only under `REGISTRY_ADAPTER_TRUST_META=1`).
- `userId` is believed as sent: the caller has already authenticated the viewer. The service reads
  that user's settings; it never authenticates anyone.

## Caching

Two layers, each short:

- **In the service**, a user's settings (found or not) are kept for `CONTENT_POLICY_CACHE_TTL_MS`
  (default 30 s), at most `CONTENT_POLICY_CACHE_MAX_ENTRIES` users. A user who changes their settings
  is answered the old ones for up to that long, plus the read replica's lag. Errors are never kept.
- **In a caller**, per viewer (user id, the location fields, the host and the context) for a short
  TTL, keyed also on `policyVersion` so a region-list change is not served stale. On no answer the
  caller uses the SFW fallback, never its last answer for someone else.

The registry adapter in shadow does not cache: it asks once per subscription start.

## Database

One query, on the read replica, by primary key:

```sql
SELECT "showNsfw", "browsingLevel", COALESCE("isModerator", false) FROM "User"
WHERE id = $1 AND "deletedAt" IS NULL AND "bannedAt" IS NULL
```

These are the columns the session user is built from unchanged, which the site and the adapter
decide with. The URL is the first of `DATAPACKET_DATABASE_RO_URL`, `DATABASE_REPLICA_URL`,
`DATABASE_URL` (feed-go's order); the pool is feed-go's (`internal/dbpool`, default 4 connections).
Each read is bounded by `CONTENT_POLICY_LOOKUP_TIMEOUT_MS` (default 250 ms); past it the answer is the
SFW fallback.

## Metrics

`/metrics`; no label is named `endpoint`.

- `content_policy_decisions_total{context, reason, region_hold}`: every answer. `reason=error` and
  `reason=invalid-input` are the fallback (seeded at 0).
- `content_policy_decision_duration_seconds{context}`: latency, user read included.
- `content_policy_user_lookups_total{result}`: `cache_hit`, `found`, `not_found`, `error`, `timeout`.
- `content_policy_db_errors_total`: user reads that failed or timed out.
- `content_policy_info{policy_version}`: 1.

`/readyz` is 200 once the database answers a ping, 503 before.

## Correctness: vectors from the real Node code

`testdata/golden/gen.ts` runs the real site and adapter functions over a matrix and writes
`testdata/golden/vectors.json`; `internal/policy` `TestGolden` decides every vector and compares the
whole decision. The matrix:

- every user setting combination: `showNsfw` off and on × 14 level classes (0, PG, SFW, each mature
  bit alone, mixes, all, Blocked alone and with all, −1) × moderator or not, and anonymous;
- every host: none, green, blue, red, a host of no color;
- 44 edge value classes: restricted, blocked and plain countries, lowercase, padded with each kind of
  whitespace, US with and without a listed state, `us` lowercase, an empty region, no country, empty,
  `XX`, `T1`, three letters, one letter, digits, `ß` / `ſe` / `ﬀ`, and `x-isuk` on, off and odd;
- both sides of the end of two dated rules (the day's start, its last two milliseconds, the next day);
- each caller context.

`scripts/__tests__/content-policy-go-vectors.schema-drift.test.ts` regenerates the file on every PR
(lint.yml) and fails when it differs, so a Node change that moves an answer cannot merge without this
service being checked against it. The constants the service decides with (level bits, the rating
ladder, the mature ratings, the edge's no-country codes, the default region lists) are generated into
`internal/policy/policydata.json` by `scripts/content-policy-go-data.ts`, with its own drift test.
The port is registered in `ports/manifest.json` (`contentPolicy.registrySubscription`, kind `policy`).

## Migrating a caller

1. **Shadow** (the registry adapter, now). Set `REGISTRY_ADAPTER_POLICY_URL`; the adapter compares
   each subscription with the service (`registry_adapter_policy_shadow_total{result}`) and logs one
   line per disagreement (the field and both values; never the user, token or address). The live
   decision does not change.
2. **Read the comparison.** Expected disagreements: a user who changed their settings within the
   cache TTL or the adapter's token re-check (five minutes), on either side. Anything else is a bug
   in one of the two; the vectors say which.
3. **Switch.** The caller decides from the service's answer, falling back to the SFW decision on any
   error or timeout, and keeps its own code only as that fallback until the switch has soaked. A
   change to a rule then lands here, once, as a context rule with its vectors.
4. **Delete** the caller's own copy.

The registry app index follows once it has a service identity to call with. The site and feed-go are
not callers yet.
