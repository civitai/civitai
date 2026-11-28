// Package modelfeed is the shadow-only port of the tRPC procedure `model.getAll` (the model browse
// feed): src/server/routers/model.router.ts (publicProcedure, input getAllModelsSchema) →
// getModelsInfiniteHandler / getModelsFeed (src/server/controllers/model.controller.ts) →
// getModelsWithImagesAndModelVersions → getModelsRaw (src/server/services/model.service.ts), for the
// request shapes it supports. Every other shape is a fallback (package fallback); the supported set is
// defined in ParseWith and grows as parity is proven. See DESIGN.md §15.
package modelfeed

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/inputschema"
)

// Sort values (ModelSort in src/server/common/enums.ts).
const (
	SortHot            = "Hot"
	SortHighestRated   = "Highest Rated"
	SortMostDownloaded = "Most Downloaded"
	SortMostLiked      = "Most Liked"
	SortMostDiscussed  = "Most Discussed"
	SortMostCollected  = "Most Collected"
	SortImageCount     = "Most Images"
	SortNewest         = "Newest"
	SortOldest         = "Oldest"
	SortRecentlyAdded  = "Recently Added"
)

// knownSorts are the ported sorts. Recently Added (getModelsRaw throws without a collection, and with
// one it joins CollectionItem to order by the item id, which is not ported) falls back.
var knownSorts = map[string]bool{
	SortHot: true, SortHighestRated: true, SortMostDownloaded: true, SortMostLiked: true,
	SortMostDiscussed: true, SortMostCollected: true, SortImageCount: true, SortNewest: true, SortOldest: true,
}

var knownPeriods = map[string]bool{"AllTime": true, "Day": true, "Week": true, "Month": true, "Year": true}

// commercialUses is the CommercialUse enum (packages/civitai-db-schema/src/enums.ts).
var commercialUses = map[string]bool{"None": true, "Image": true, "RentCivit": true, "Rent": true, "Sell": true, "SellMerge": true}

// checkpointTypes is the CheckpointType enum.
var checkpointTypes = map[string]bool{"Trained": true, "Merge": true}

// fileFormats is constants.modelFileFormats (src/server/common/constants.ts). getModelsRaw interpolates
// each one into the SQL text, so only these exact values may reach it.
var fileFormats = map[string]bool{"SafeTensor": true, "PickleTensor": true, "GGUF": true, "Diffusers": true, "Core ML": true, "ONNX": true, "Other": true}

// Input is getAllModelsSchema as model.getAll reads it, for the supported subset.
type Input struct {
	// Limit is `limit` (0–100); 100 when absent (getModelsFeed's `input.limit ?? 100`).
	Limit int
	// Cursor is the keyset cursor as sent: the previous page's `nextCursor`, a `CONCAT(col, '|', …)`
	// string. "" = none.
	Cursor        string
	Sort          string
	Period        string // AllTime, Day, Week, Month, Year
	PeriodMode    string // published, stats
	BrowsingLevel *int   // raw, before the domain cap; nil = absent (the schema has no default)
	// Tag is `tagname ?? tag`: one tag name. "" = none.
	Tag string
	// Username is the `username` input after its postgresSlugify transform ("" when it slugifies to
	// nothing); User is the raw `user` input. The creator filter reads `username || user`.
	Username string
	User     string
	Types    []string
	// BaseModels is `baseModels` as an array; nil when absent.
	BaseModels            []string
	CheckpointType        string
	AllowCommercialUse    []string
	AllowDerivatives      *bool
	AllowDifferentLicense *bool
	AllowNoCredit         *bool
	EarlyAccess           bool
	PaidAccess            bool
	HidePaid              bool
	OnSale                bool
	FromPlatform          bool
	Archived              bool
	FileFormats           []string
	DisablePoi            bool
	DisableMinor          bool
	ExcludedTagIDs        []int
	ExcludedUserIDs       []int
	// CollectionID is `collectionId` (0 = none: getModelsRaw's `if (collectionId)`); CollectionTagID is
	// `collectionTagId`, read only with a collection (0 = none).
	CollectionID    int
	CollectionTagID int
	// Favorites is `favorites` (booleanString, default false). getModelsRaw never reads it; only the
	// personal Hot lead's eligibility does (PersonalHotLeadEligible).
	Favorites bool
	// HasIDs is `ids` present at all (read only with Ports.IDs; otherwise `ids` falls back): after
	// commaDelimitedNumberArray every present value is an array, `[]` included, and any array turns
	// getModelsRaw's hidePrivateModels off. IDs is that array; a non-empty one filters the page to
	// those models (`mm."modelId" IN (…)`), an empty one filters nothing.
	HasIDs bool
	IDs    []int
	// Followed is `followed` (booleanString; read only with Ports.Followed, otherwise a truthy value
	// falls back): any truthy value turns hidePrivateModels off, and for a signed-in viewer the page is
	// held to the creators they follow.
	Followed bool
	// NewCreators is `newCreators` (booleanString; read only with Ports.NewCreators, otherwise a truthy
	// value falls back): the page is held to the creators on the request's "new & upcoming" board.
	NewCreators bool
	// PublishedFrom / PublishedTo are `publishedFrom` / `publishedTo` (read only with
	// Ports.PublishedRange, otherwise a non-empty one falls back): each a UTC day (its midnight),
	// both set or neither (zero).
	PublishedFrom time.Time
	PublishedTo   time.Time
}

// Ports are the input shapes ported behind their own serve switch, each off by default: off, the
// shape falls back as it always has (`input-ids`, `input-followed`, `input-newCreators`,
// `input-publishedFrom`, …), so turning one on is the only way it is ever computed (DESIGN.md
// §15.2.4, §15.2.8, §15.2.9).
type Ports struct {
	// IDs is FEED_GO_GETALL_SERVE_INPUT_IDS: compute a request with `ids`.
	IDs bool
	// Followed is FEED_GO_GETALL_SERVE_INPUT_FOLLOWED: compute a request with `followed`.
	Followed bool
	// HidePaid is FEED_GO_GETALL_SERVE_HIDE_PAID: compute a request with `hidePaid` true (the
	// free-version rule, DESIGN.md §15.2.7). Off, it is the `input-hidePaid` fallback.
	HidePaid bool
	// NewCreators is FEED_GO_GETALL_SERVE_INPUT_NEW_CREATORS: compute a request with `newCreators`.
	NewCreators bool
	// PublishedRange is FEED_GO_GETALL_SERVE_INPUT_PUBLISHED_RANGE: compute a request with
	// `publishedFrom` / `publishedTo`.
	PublishedRange bool
}

// modelsSchema is model.getAll's allow-list and defaults (why: the inputschema package doc).
var modelsSchema = inputschema.Get(inputschema.AllModels)

// modelsDefaults are the schema defaults ParseWith starts from, decoded once at package init.
var modelsDefaults = struct{ sort, period, periodMode string }{
	sort: modelsSchema.DefaultString("sort"), period: modelsSchema.DefaultString("period"),
	periodMode: modelsSchema.DefaultString("periodMode"),
}

// trpcTransportKeys are keys the site's tRPC client adds to every input and zod strips: `authed`
// (authedCacheBypassLink, signed in) and `direction` (an infinite query's paging direction).
var trpcTransportKeys = map[string]bool{"authed": true, "direction": true}

// parsedKeys are the schema keys ParseWith reads (`favorites` only for PersonalHotLeadEligible: getModelsRaw
// never reads it); ignoredKeys the ones getModelsRaw never reads (rating, excludedModelIds,
// excludedImageIds, and collectionItemStatus: getModelsRaw
// builds its collection item filter without `statuses`), as zod's strip and the destructuring leave
// them. With unsupportedKeys they are every key of the schema (TestInputKeyLedger), so a key added
// to it must be classified.
var (
	parsedKeys = []string{
		"limit", "cursor", "sort", "period", "periodMode", "browsingLevel", "tagname", "tag", "username",
		"user", "types", "baseModels", "checkpointType", "allowCommercialUse", "allowDerivatives",
		"allowDifferentLicense", "allowNoCredit", "earlyAccess", "paidAccess", "hidePaid", "onSale",
		"fromPlatform", "archived", "fileFormats", "disablePoi", "disableMinor", "excludedTagIds",
		"excludedUserIds", "collectionId", "collectionTagId", "favorites",
	}
	ignoredKeys = []string{
		"rating", "excludedModelIds", "excludedImageIds", "collectionItemStatus",
	}
)

// unsupportedKeys are input keys that change the answer in ways not ported. Present with a truthy
// value (isEmpty: not null, false, 0, "" or []), they make the request fall back with reason
// `input-<key>`; `ids` falls back whenever it is present unless its port is on (ParseWith).
var unsupportedKeys = []string{
	// Meilisearch (`query`), the viewer's engagements and follows, the new-creators board, id lists,
	// moderator filters, drafts and pending images, the coverage filter, the featured list, a
	// published-date range, an availability filter, page-based paging.
	"query", "hidden", "followed", "newCreators", "ids", "modelVersionIds", "status",
	"needsReview", "pending", "supportsGeneration", "isFeatured", "availability", "publishedFrom",
	"publishedTo", "poiOnly", "minorOnly", "page",
}

// UnsupportedInputKeys are the keys ParseWith falls back on (with every port off) as `input-<key>` (a copy; `ids` among them).
func UnsupportedInputKeys() []string { return append([]string(nil), unsupportedKeys...) }

// ParseWith validates the decoded input map (trpc.DecodeEnvelope's output), reading the input shapes
// the ports p switches on instead of falling back on them. A shape outside the supported subset is a
// fallback, and so is a value the schema itself rejects (Node answers it with its own BAD_REQUEST,
// which the sampler never mirrors).
func ParseWith(m map[string]any, p Ports) (*Input, error) {
	// `ids` changes the answer whenever it is present at all: commaDelimitedNumberArray turns [] into
	// [], "" into [0] and null into [], and getModelsRaw's hidePrivateModels is `!ids && …`, so even
	// an empty list shows private models (and "" filters to model 0). Read only with p.IDs.
	if _, ok := m["ids"]; ok && !p.IDs {
		return nil, fallback.New("input-ids")
	}
	for _, k := range unsupportedKeys {
		if (k == "ids" && p.IDs) || (k == "followed" && p.Followed) || (k == "newCreators" && p.NewCreators) ||
			((k == "publishedFrom" || k == "publishedTo") && p.PublishedRange) {
			continue
		}
		if v, ok := m[k]; ok && !isEmpty(v) {
			return nil, fallback.New("input-" + k)
		}
	}
	// After unsupported keys so the reason names the parity gap.
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	if k, ok := modelsSchema.Unknown(keys, trpcTransportKeys); ok {
		return nil, fallback.NewfSafe("input-unknown-key", fallback.Token(k), "%s", k)
	}
	// The limit is the handler's (`limit = 100`): the schema's is optional, with no default.
	in := &Input{
		Limit: 100, Sort: modelsDefaults.sort, Period: modelsDefaults.period,
		PeriodMode: modelsDefaults.periodMode,
	}
	var err error
	if v, ok := m["limit"]; ok && v != nil {
		if in.Limit, err = intIn(v, 0, 100); err != nil {
			return nil, fallback.NewfSafe("input-invalid", "limit", "limit: %v", err)
		}
	}
	if v, ok := m["cursor"]; ok && v != nil {
		s, isStr := v.(string)
		if !isStr {
			// A number (or a bigint/Date) is one value for a sort of two or three fields: Node's
			// parseCursor answers it with a 400.
			return nil, fallback.New("model-cursor")
		}
		in.Cursor = s
	}
	if v, ok := m["sort"]; ok && v != nil {
		s, _ := v.(string)
		if s == SortRecentlyAdded {
			// With or without a collection: without one Node throws a 400, with one it orders by the
			// collection item, which is not ported.
			return nil, fallback.New("model-sort-recently-added")
		}
		if !knownSorts[s] {
			return nil, fallback.NewfSafe("input-invalid", "sort", "sort %v", v)
		}
		in.Sort = s
	}
	if v, ok := m["period"]; ok && v != nil {
		s, _ := v.(string)
		if !knownPeriods[s] {
			return nil, fallback.NewfSafe("input-invalid", "period", "period %v", v)
		}
		in.Period = s
	}
	if v, ok := m["periodMode"]; ok && v != nil {
		s, _ := v.(string)
		if s != "published" && s != "stats" {
			return nil, fallback.NewfSafe("input-invalid", "periodMode", "periodMode %v", v)
		}
		in.PeriodMode = s
	}
	if v, ok := m["browsingLevel"]; ok && v != nil {
		n, err := intIn(v, 0, math.MaxInt32)
		if err != nil {
			return nil, fallback.NewfSafe("input-invalid", "browsingLevel", "browsingLevel: %v", err)
		}
		in.BrowsingLevel = &n
	}
	// `tagname ?? tag`: a tagname that is present wins even when empty (an empty name finds no tag and
	// adds no filter either way).
	tagname, hasTagname, err := optString(m, "tagname")
	if err != nil {
		return nil, err
	}
	tag, _, err := optString(m, "tag")
	if err != nil {
		return nil, err
	}
	in.Tag = tag
	if hasTagname {
		in.Tag = tagname
	}
	username, _, err := optString(m, "username")
	if err != nil {
		return nil, err
	}
	in.Username = PostgresSlugify(username)
	if in.User, _, err = optString(m, "user"); err != nil {
		return nil, err
	}
	if in.Types, err = oneOrMany(m["types"], func(s string) bool { return modelTypes[s] }); err != nil {
		return nil, err
	}
	if in.BaseModels, err = oneOrMany(m["baseModels"], func(string) bool { return true }); err != nil {
		return nil, err
	}
	if v, ok := m["checkpointType"]; ok && v != nil {
		s, _ := v.(string)
		if !checkpointTypes[s] {
			return nil, fallback.NewfSafe("input-invalid", "checkpointType", "checkpointType %v", v)
		}
		in.CheckpointType = s
	}
	// licensingSchema: allowCommercialUse is preprocessed (a falsy value is absent, one value becomes
	// a list); the other three are plain optional booleans, where false is a filter too.
	if v, ok := m["allowCommercialUse"]; ok && !isEmpty(v) {
		if in.AllowCommercialUse, err = oneOrMany(v, func(s string) bool { return commercialUses[s] }); err != nil {
			return nil, err
		}
	}
	for key, dst := range map[string]**bool{"allowDerivatives": &in.AllowDerivatives, "allowDifferentLicense": &in.AllowDifferentLicense, "allowNoCredit": &in.AllowNoCredit} {
		if v, ok := m[key]; ok && v != nil {
			b, isBool := v.(bool)
			if !isBool {
				return nil, fallback.NewfSafe("input-invalid", fallback.Token(key), "%s %v", key, v)
			}
			*dst = &b
		}
	}
	for key, dst := range map[string]*bool{
		"earlyAccess": &in.EarlyAccess, "paidAccess": &in.PaidAccess, "hidePaid": &in.HidePaid,
		"onSale": &in.OnSale, "fromPlatform": &in.FromPlatform, "archived": &in.Archived,
		"favorites": &in.Favorites,
	} {
		if *dst, err = booleanString(m[key]); err != nil {
			return nil, fallback.NewfSafe("input-invalid", fallback.Token(key), "%s: %v", key, err)
		}
	}
	if v, ok := m["fileFormats"]; ok && v != nil {
		list, isList := v.([]any)
		if !isList {
			return nil, fallback.New("input-invalid")
		}
		for _, e := range list {
			s, _ := e.(string)
			if !fileFormats[s] {
				return nil, fallback.NewfSafe("input-invalid", "fileFormats", "fileFormats %v", e)
			}
			in.FileFormats = append(in.FileFormats, s)
		}
	}
	for key, dst := range map[string]*bool{"disablePoi": &in.DisablePoi, "disableMinor": &in.DisableMinor} {
		if v, ok := m[key]; ok && v != nil {
			b, isBool := v.(bool)
			if !isBool {
				return nil, fallback.NewfSafe("input-invalid", fallback.Token(key), "%s %v", key, v)
			}
			*dst = b
		}
	}
	if in.ExcludedTagIDs, err = ints(m["excludedTagIds"]); err != nil {
		return nil, err
	}
	if in.ExcludedUserIDs, err = ints(m["excludedUserIds"]); err != nil {
		return nil, err
	}
	if in.CollectionID, in.CollectionTagID, err = collectionKeys(m); err != nil {
		return nil, err
	}
	if v, ok := m["ids"]; ok && p.IDs {
		in.HasIDs = true
		if in.IDs, err = commaDelimitedIDs(v); err != nil {
			return nil, err
		}
	}
	if p.Followed {
		if in.Followed, err = booleanString(m["followed"]); err != nil {
			return nil, fallback.NewfSafe("input-invalid", "followed", "followed: %v", err)
		}
	}
	// `newCreators: booleanString().optional()`: present, it must be a boolean, a z.stringbool string
	// or a number; null is the schema's 400 too (optional admits only an absent key).
	if v, ok := m["newCreators"]; ok && p.NewCreators {
		if v == nil {
			return nil, fallback.NewfSafe("input-invalid", "newCreators", "newCreators: null")
		}
		if in.NewCreators, err = booleanString(v); err != nil {
			return nil, fallback.NewfSafe("input-invalid", "newCreators", "newCreators: %v", err)
		}
	}
	var hasFrom, hasTo bool
	if p.PublishedRange {
		if in.PublishedFrom, hasFrom, err = publishedDay(m, "publishedFrom"); err != nil {
			return nil, err
		}
		if in.PublishedTo, hasTo, err = publishedDay(m, "publishedTo"); err != nil {
			return nil, err
		}
		// getModelsRaw's publishedRangeError, a 400 thrown before any read: after every schema check,
		// which zod makes first.
		if err := publishedRangeError(in.PublishedFrom, in.PublishedTo, hasFrom, hasTo); err != nil {
			return nil, err
		}
	}
	// Last, so a value the schema refuses is still input-invalid. Node keeps a gated model that has a
	// free Published version and shows that version; only the port behind p.HidePaid does too.
	if in.HidePaid && !p.HidePaid {
		return nil, fallback.New("input-hidePaid")
	}
	return in, nil
}

// publishedDayPattern is publishedDateSchema's DATE_RE (src/shared/utils/published-range.ts): JS `\d`
// is ASCII only.
var publishedDayPattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

// publishedRangeMaxDays is PUBLISHED_RANGE_MAX_DAYS.
const publishedRangeMaxDays = 31

// publishedDay reads `publishedFrom` / `publishedTo` through publishedDateSchema.optional(): absent is
// no day; present, it must be a string of the form YYYY-MM-DD that names a real UTC calendar day (the
// schema's `new Date(…T00:00:00.000Z).toISOString()` round trip, which a day past the month's end
// fails). Anything else, null and "" included, is the schema's 400 (input-invalid). The day is its
// UTC midnight.
func publishedDay(m map[string]any, key string) (time.Time, bool, error) {
	v, ok := m[key]
	if !ok {
		return time.Time{}, false, nil
	}
	s, isStr := v.(string)
	if !isStr || !publishedDayPattern.MatchString(s) {
		return time.Time{}, false, fallback.NewfSafe("input-invalid", fallback.Token(key), "%s %v", key, v)
	}
	t, err := time.Parse(time.DateOnly, s)
	if err != nil || t.Format(time.DateOnly) != s {
		return time.Time{}, false, fallback.NewfSafe("input-invalid", fallback.Token(key), "%s %q", key, s)
	}
	return t, true, nil
}

// publishedRangeError is publishedRangeError (published-range.ts): neither end is no range; one end
// only, an end before the start, or more than PUBLISHED_RANGE_MAX_DAYS between them is Node's 400
// (`input-published-range`). A day this port cannot carry is that fallback too: year 0 (Postgres has
// no year 0) and 0001-01-01, which is time.Time's zero, the "no range" the page query reads.
func publishedRangeError(from, to time.Time, hasFrom, hasTo bool) error {
	switch {
	case !hasFrom && !hasTo:
		return nil
	case !hasFrom || !hasTo:
		return fallback.NewfSafe("input-published-range", "one-end", "one end of the published range")
	case to.Before(from):
		return fallback.NewfSafe("input-published-range", "reversed", "publishedTo before publishedFrom")
	case to.Sub(from) > publishedRangeMaxDays*24*time.Hour:
		return fallback.NewfSafe("input-published-range", "too-wide", "a published range over %d days", publishedRangeMaxDays)
	case from.IsZero() || from.Year() == 0 || to.Year() == 0:
		return fallback.NewfSafe("input-published-range", "day-out-of-range", "a published day this port cannot bind")
	}
	return nil
}

// commaDelimitedIDs is `ids` through commaDelimitedNumberArray (src/utils/zod-helpers.ts): a string is
// split on `,` and each part trimmed (stringToArray), an array is taken as it is, null is [] (the
// preprocess runs on it: `(null ?? []).map(String)`), and every element then goes through JS
// `Number` and must be a finite number (`z.number()`, else the schema's 400).
// Only what Number reads unambiguously is read here: an integer (a JSON integer, or a string of
// optional ASCII blanks, an optional sign, decimal digits and blanks), and an empty or blank string
// (0). Any other element (a fraction, an exponent, a hex or other spelling Number accepts, a string
// Number reads as NaN, another type), and an id outside int4 (Node binds it; no row holds it), is
// `model-ids`: Node answers those itself, its 400 included.
func commaDelimitedIDs(v any) ([]int, error) {
	var elems []any
	switch t := v.(type) {
	case nil:
		return []int{}, nil
	case string:
		for _, part := range strings.Split(t, ",") {
			elems = append(elems, part)
		}
	case []any:
		elems = t
	default:
		// A number or an object: stringToArray's `.map` throws in Node.
		return nil, fallback.Safef("model-ids", "%T", v)
	}
	out := make([]int, 0, len(elems))
	for _, e := range elems {
		var f float64
		switch t := e.(type) {
		case json.Number:
			n, err := t.Float64()
			if err != nil {
				return nil, fallback.Safef("model-ids", "number")
			}
			f = n
		case string:
			s := strings.Trim(t, " \t\n\r")
			switch {
			case s == "":
				f = 0
			case plainInteger.MatchString(s):
				n, err := strconv.ParseFloat(s, 64)
				if err != nil {
					return nil, fallback.Safef("model-ids", "string")
				}
				f = n
			default:
				return nil, fallback.Safef("model-ids", "string")
			}
		default:
			return nil, fallback.Safef("model-ids", "%T", e)
		}
		if f != math.Trunc(f) || f < math.MinInt32 || f > math.MaxInt32 {
			return nil, fallback.Safef("model-ids", "range")
		}
		out = append(out, int(f))
	}
	return out, nil
}

// plainInteger is a decimal integer JS Number reads as that integer.
var plainInteger = regexp.MustCompile(`^[+-]?[0-9]+$`)

// collectionKeys reads `collectionId` and `collectionTagId` (both `z.number().optional()`): a value
// that is not a number, null included, is the schema's 400 (input-invalid). getModelsRaw tests each
// for truthiness, so 0 is no filter, and binds it as it came; a collection id or tag id that is not
// an int4 integer is not ported (model-collection-id: Postgres would compare it as a numeric, and no
// row holds it). The tag is read only with a collection, as getModelsRaw reads it.
func collectionKeys(m map[string]any) (collectionID, tagID int, err error) {
	num := func(key string) (json.Number, bool, error) {
		v, ok := m[key]
		if !ok {
			return "", false, nil
		}
		n, isNum := v.(json.Number)
		if !isNum {
			return "", false, fallback.NewfSafe("input-invalid", fallback.Token(key), "%s %v", key, v)
		}
		return n, true, nil
	}
	id, hasID, err := num("collectionId")
	if err != nil {
		return 0, 0, err
	}
	tag, hasTag, err := num("collectionTagId")
	if err != nil {
		return 0, 0, err
	}
	if !hasID || isEmpty(id) {
		return 0, 0, nil
	}
	if collectionID, err = intIn(id, math.MinInt32, math.MaxInt32); err != nil {
		return 0, 0, fallback.NewfSafe("model-collection-id", "collectionId", "collectionId: %v", err)
	}
	if hasTag && !isEmpty(tag) {
		if tagID, err = intIn(tag, math.MinInt32, math.MaxInt32); err != nil {
			return 0, 0, fallback.NewfSafe("model-collection-id", "collectionTagId", "collectionTagId: %v", err)
		}
	}
	return collectionID, tagID, nil
}

// creatorName is `username || user`: the name the creator filter looks up ("" = no filter).
func (in *Input) creatorName() string {
	if in.Username != "" {
		return in.Username
	}
	return in.User
}

var slugStrip = regexp.MustCompile(`[^a-zA-Z0-9_]`)

// PostgresSlugify is postgresSlugify (src/utils/string-helpers.ts): the FIRST space becomes `_`
// (String#replace with a string pattern replaces one occurrence), every other character outside
// [a-zA-Z0-9_] is dropped, and the result is lowercased.
func PostgresSlugify(s string) string {
	if s == "" {
		return ""
	}
	s = strings.Replace(s, " ", "_", 1)
	return strings.ToLower(slugStrip.ReplaceAllString(s, ""))
}

func optString(m map[string]any, key string) (string, bool, error) {
	v, ok := m[key]
	if !ok || v == nil {
		return "", false, nil
	}
	s, isStr := v.(string)
	if !isStr {
		return "", false, fallback.NewfSafe("input-invalid", fallback.Token(key), "%s %v", key, v)
	}
	return s, true, nil
}

// oneOrMany reads a `z.union([x, x.array()])` field transformed to an array: one value becomes a list,
// an absent or empty value is nil. Every element must satisfy ok.
func oneOrMany(v any, ok func(string) bool) ([]string, error) {
	switch t := v.(type) {
	case nil:
		return nil, nil
	case string:
		if !ok(t) {
			return nil, fallback.Newf("input-invalid", "%q", t)
		}
		if t == "" {
			return nil, nil // `!rel ? undefined`
		}
		return []string{t}, nil
	case []any:
		out := make([]string, 0, len(t))
		for _, e := range t {
			s, isStr := e.(string)
			if !isStr || !ok(s) {
				return nil, fallback.Newf("input-invalid", "%v", e)
			}
			out = append(out, s)
		}
		return out, nil
	}
	return nil, fallback.Safef("input-invalid", "%T", v)
}

// booleanString is booleanString() (src/utils/zod-helpers.ts): a boolean, a z.stringbool() string,
// or a number (true only for 1). Absent or null is false.
func booleanString(v any) (bool, error) {
	switch t := v.(type) {
	case nil:
		return false, nil
	case bool:
		return t, nil
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return false, err
		}
		return f == 1, nil
	case string:
		switch strings.ToLower(t) {
		case "true", "1", "yes", "on", "y", "enabled":
			return true, nil
		case "false", "0", "no", "off", "n", "disabled":
			return false, nil
		}
	}
	return false, fmt.Errorf("not a boolean string: %v", v)
}

func isEmpty(v any) bool {
	switch t := v.(type) {
	case nil:
		return true
	case bool:
		return !t
	case string:
		return t == ""
	case []any:
		return len(t) == 0
	case json.Number:
		f, err := t.Float64()
		return err == nil && f == 0
	}
	return false
}

func intIn(v any, lo, hi int) (int, error) {
	n, ok := v.(json.Number)
	if !ok {
		return 0, fmt.Errorf("not a number: %v", v)
	}
	f, err := n.Float64()
	if err != nil {
		return 0, err
	}
	if f != math.Trunc(f) || f < float64(lo) || f > float64(hi) {
		return 0, fmt.Errorf("out of range: %v", v)
	}
	return int(f), nil
}

func ints(v any) ([]int, error) {
	if v == nil {
		return nil, nil
	}
	list, ok := v.([]any)
	if !ok {
		return nil, fallback.New("input-invalid")
	}
	out := make([]int, 0, len(list))
	for _, e := range list {
		n, err := intIn(e, math.MinInt32, math.MaxInt32)
		if err != nil {
			return nil, fallback.Newf("input-invalid", "%v", e)
		}
		out = append(out, n)
	}
	return out, nil
}
