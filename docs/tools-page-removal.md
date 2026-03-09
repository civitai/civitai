# Tools Page Removal — Dependency Analysis

Analysis of all components, utils, and server code that can be removed or cleaned up when removing the `/tools` page.

## Files to Completely Remove (19 files)

### Components (`src/components/Tool/`)
| File | Description |
|------|-------------|
| `src/components/Tool/ToolBanner.tsx` | Banner for tool detail pages |
| `src/components/Tool/ToolFiltersDropdown.tsx` | Filter dropdown for tool listings |
| `src/components/Tool/ToolFiltersDropdown.module.scss` | Styles for filter dropdown |
| `src/components/Tool/ToolFiltersDropdown.module.scss.d.ts` | TS defs for SCSS module |
| `src/components/Tool/ToolsInfinite.tsx` | Infinite scroll for tool listings |
| `src/components/Tool/ToolMultiSelect.tsx` | Multi-select dropdown (exports `ToolMultiSelect` + `ToolSelect`) |
| `src/components/Tool/tools.utils.ts` | `useToolFilters()` and `useQueryTools()` hooks |

### Cards
| File | Description |
|------|-------------|
| `src/components/Cards/ToolCard.tsx` | Card component for displaying tools |

### Pages
| File | Description |
|------|-------------|
| `src/pages/tools/index.tsx` | Main tools listing page |
| `src/pages/tools/[slug].tsx` | Individual tool detail page |
| `src/pages/sitemap-tools.xml/index.tsx` | XML sitemap generator for tools |
| `src/pages/search/tools.tsx` | Tools search/discovery page |

### Server
| File | Description |
|------|-------------|
| `src/server/routers/tool.router.ts` | tRPC router (`tool.getAll`) |
| `src/server/schema/tool.schema.ts` | Zod schemas (`GetAllToolsSchema`, `ToolMetadata`) |
| `src/server/services/tool.service.ts` | Service (`getAllTools`, `getToolByAlias`, etc.) |
| `src/server/search-index/tools.search-index.ts` | Meilisearch index config |

### Search/Filters (exclusively tools)
| File | Description |
|------|-------------|
| `src/components/Search/parsers/tool.parser.ts` | URL routing parser for tools search |
| `src/components/Filters/FeedFilters/ToolFeedFilters.tsx` | Feed filters for `/tools` |
| `src/components/Filters/FeedFilters/ToolImageFeedFilters.tsx` | Feed filters for `/tools/[slug]` |

### Autocomplete
| File | Description |
|------|-------------|
| `src/components/AutocompleteSearch/renderItems/tools.tsx` | Tool search item renderer |

---

## Shared Files Needing Cleanup (~15 files)

These files are used by other features but contain tool-specific references to remove.

### Server
| File | What to remove |
|------|----------------|
| `src/server/routers/index.ts` | `toolRouter` import + `tool: toolRouter` entry |
| `src/server/common/enums.ts` | `ToolSort` enum |
| `src/server/common/constants.ts` | `TOOLS_SEARCH_INDEX` constant |
| `src/types/router.ts` | `ToolGetAllModel` type |

### Navigation / Layout
| File | What to remove |
|------|----------------|
| `src/components/AppLayout/SubNav.tsx` | `/tools` and `/tools/[slug]` entries in `filterSections` |
| `src/components/HomeContentToggle/HomeContentToggle.tsx` | Tools option + `features.toolSearch` conditional |

### Filters / Sorting
| File | What to remove |
|------|----------------|
| `src/components/Image/Filters/MediaFiltersDropdown.tsx` | `ToolMultiSelect` import + tool filter section (has `hideTools` prop) |
| `src/components/Collections/Collection.tsx` | `ToolMultiSelect` usage + tool filtering state/UI |
| `src/components/Filters/SortFilter.tsx` | `ToolSort` from type unions + sort options |
| `src/providers/FiltersProvider.tsx` | `ToolFilterSchema` definition + `tools` entry in `StorageState` |

### Search / Autocomplete
| File | What to remove |
|------|----------------|
| `src/components/AutocompleteSearch/AutocompleteSearch.tsx` | `ToolSearchItem` import + tools renderItems entry + `features.toolSearch` check |
| `src/components/Search/useSearchState.ts` | Tool-related imports and state |
| `src/components/Search/search.utils2.ts` | `ToolsTransformed`, `toolsTransform`, tools entry in maps |
| `src/components/Search/QuickSearchDropdown.tsx` | Tool search item registration |

---

## DO NOT Remove

These are **not** tied to the tools page and should be kept:

| File/Entity | Reason |
|-------------|--------|
| `Tool` / `ImageTool` Prisma models | Used for image metadata tracking |
| `src/components/Post/EditV2/Tools/PostImageToolsPopover.tsx` | Image metadata in post editor |
| `src/components/Post/EditV2/Tools/PostImageTool.tsx` | Image metadata in post editor |
| Database `Tool` / `ImageTool` tables | Historical data, image metadata |
