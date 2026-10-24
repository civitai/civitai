---
paths:
  - "src/pages/api/v1/**"
  - "src/server/services/image-search.service.ts"
  - "src/server/utils/public-*.ts"
---

# Public REST API (`src/pages/api/v1/`)

These routes are a published contract, documented by hand at
[developer.civitai.com](https://developer.civitai.com/site/reference/) from the
[`civitai/civitai-developer-docs`](https://github.com/civitai/civitai-developer-docs) repo, one page per
resource under `site/reference/`. Nothing generates those pages or checks them against this code.

**When a change alters what a documented endpoint accepts or returns, update its page in the same piece
of work**, and open the docs PR alongside the code PR, each linking the other. That covers:

- a new, renamed or removed endpoint, query or path parameter, or response field;
- a changed type, default, limit, nullability, sort order or enum value;
- a changed auth requirement, rate limit, cache header, error status or region/maturity gate.

The trigger is the response shape, not the file: shapes are often built in a service. `thumbnail` on
`/images` items is added in `src/server/services/image-search.service.ts`, and both `/images` and
`/posts/{id}` serve those items.

`site/reference/index.md` lists which endpoints are documented. Not every route under
`src/pages/api/v1/` is public (App Block, partner and internal routes have their own docs or none). A
new public endpoint gets a page, an index row and a sidebar entry in `.vitepress/config.mts`.

The docs repo's `openapi-parity-checker` agent diffs a page against these handlers; run it with this
repo checked out as its sibling `../civitai`. Merge the docs PR only after the API change is released,
since its "try it" widgets call production.
