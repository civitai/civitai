# Public REST API documentation

The routes under `src/pages/api/v1/` are a published contract, documented by hand at
[developer.civitai.com](https://developer.civitai.com/site/reference/) from the
[`civitai/civitai-developer-docs`](https://github.com/civitai/civitai-developer-docs) repo, one page per
resource under `site/reference/`. Nothing generates those pages or checks them against this code, so a
change that skips them leaves the published reference wrong.

**When a change alters what a documented endpoint accepts or returns, update its page in the same
piece of work** and open the docs PR alongside the code PR, linking each from the other. That covers:

- a new, renamed or removed endpoint, query or path parameter, or response field;
- a changed type, default, limit, nullability, sort order or enum value;
- a changed auth requirement, rate limit, cache header, error status or region/maturity gate.

The response shape is often built outside `src/pages/api/v1/`, so the trigger is the shape, not the file:
`thumbnail` on `/images` items was added in `src/server/services/image-search.service.ts`, and both
`/images` and `/posts/{id}` serve those items.

`site/reference/index.md` lists which endpoints are documented. Not every route under `src/pages/api/v1/` is public (App
Block, partner and internal routes have their own docs or none). A new public endpoint gets a page,
an index row and a sidebar entry in `.vitepress/config.mts`.

The docs repo's `openapi-parity-checker` agent diffs a page against these handlers. Run it after
editing, with this repo checked out as its sibling `../civitai`. Merge the docs PR only after the API
change has been released, since its "try it" widgets call production.
