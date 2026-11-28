package v1models

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
)

// ListInput is modelsEndpointSchema.safeParse(req.query) (src/server/schema/model.schema.ts) for
// the ported subset, after its defaults and transforms.
type ListInput struct {
	Limit           int // 1-100, default 100
	Page            int // 0 = absent
	Cursor          string
	Sort            string
	Period          string
	PeriodMode      string
	Types           []string
	BaseModels      []string
	Username        string // postgresSlugify'd; "" = no filter
	Nsfw            bool
	PrimaryFileOnly bool
	EarlyAccess     bool
	Archived        bool
	IDs             []int // nil = absent
	// Tag is the `tag` filter's name ("" = none: the empty string is falsy to `tagname ?? tag`).
	Tag string
	// Text is a truthy `query`: the text search (DESIGN.md §16.11); "" = the database path.
	Text string
	// TextOffset is the text search's offset, the `cursor` read as a number (0 = none).
	TextOffset int
	// SortNamed: the request names `sort` (`'sort' in req.query`), so the text search sorts by it.
	SortNamed bool
	// Query is req.query in Object.keys order, for nextPage.
	Query []feed.QueryParam
}

// ported are the schema keys this port reads. Every other schema key falls back with its own reason;
// a key outside the schema is ignored, as zod ignores it, and kept for nextPage.
var ported = map[string]bool{
	"limit": true, "page": true, "cursor": true, "sort": true, "period": true, "periodMode": true,
	"types": true, "baseModels": true, "username": true, "nsfw": true, "primaryFileOnly": true,
	"earlyAccess": true, "archived": true, "ids": true, "status": true, "tag": true,
}

// unported are the schema's other keys (getAllModelsSchema + userPreferencesSchema + the endpoint's
// own), each its own fallback reason (`v1-models-<key>`), so the reason label is bounded by the schema.
// `query` is read apart (textQueryAbsent): a truthy one is the text search (ListInput.Text).
var unported = map[string]bool{
	"tagname": true, "user": true, "rating": true, "favorites": true,
	"hidden": true, "checkpointType": true, "needsReview": true, "paidAccess": true, "hidePaid": true,
	"onSale": true, "modelVersionIds": true, "supportsGeneration": true, "fromPlatform": true,
	"followed": true, "newCreators": true, "collectionId": true, "collectionItemStatus": true,
	"fileFormats": true, "pending": true, "collectionTagId": true, "availability": true,
	"disablePoi": true, "disableMinor": true, "isFeatured": true, "poiOnly": true, "minorOnly": true,
	"allowNoCredit": true, "allowCommercialUse": true, "allowDerivatives": true, "allowDifferentLicense": true,
	"browsingLevel": true, "excludedModelIds": true, "excludedUserIds": true, "excludedTagIds": true,
	"excludedImageIds": true,
}

// authedOnly are the unported keys a signed-out caller is refused on (authedOnlyOptions: a 401),
// checked before unported: their own `v1-models-<key>` reason is never reached.
var authedOnly = map[string]bool{"favorites": true, "hidden": true}

// UnportedFallbackKeys are the keys whose `v1-models-<key>` fallback ParseList can reach: the unported
// keys less authedOnly, sorted.
func UnportedFallbackKeys() []string {
	out := make([]string, 0, len(unported))
	for k := range unported {
		if !authedOnly[k] {
			out = append(out, k)
		}
	}
	slices.Sort(out)
	return out
}

var (
	digits = regexp.MustCompile(`^[0-9]{1,10}$`)
	// offsetDigits is a text search cursor read here: decimal digits Number() reads as the same
	// integer, short enough that the next offset stays an int4.
	offsetDigits = regexp.MustCompile(`^[0-9]{1,9}$`)
)

// zod's stringbool defaults, compared case-insensitively (booleanString on a query string).
var (
	stringboolTrue  = map[string]bool{"true": true, "1": true, "yes": true, "on": true, "y": true, "enabled": true}
	stringboolFalse = map[string]bool{"false": true, "0": true, "no": true, "off": true, "n": true, "disabled": true}
)

func boolParam(key string, vals []string) (bool, error) {
	if len(vals) != 1 {
		return false, fallback.New("v1-models-input-duplicate")
	}
	l := strings.ToLower(vals[0])
	switch {
	case stringboolTrue[l]:
		return true, nil
	case stringboolFalse[l]:
		return false, nil
	}
	return false, fallback.NewfSafe("v1-models-input-bool", fallback.Token(key), "%s", key)
}

// intParam reads a value Number() turns into a plain integer the same way: decimal digits only.
func intParam(vals []string) (int, error) {
	if len(vals) != 1 || !digits.MatchString(vals[0]) {
		return 0, fallback.New("v1-models-input-number")
	}
	n, err := strconv.Atoi(vals[0])
	if err != nil || n > int4Max {
		return 0, fallback.New("v1-models-input-number")
	}
	return n, nil
}

func scalar(vals []string) (string, error) {
	if len(vals) != 1 {
		return "", fallback.New("v1-models-input-duplicate")
	}
	return vals[0], nil
}

// postgresSlugify (src/utils/string-helpers.ts): the FIRST space an underscore, everything outside
// [a-zA-Z0-9_] dropped, lowercased.
func postgresSlugify(s string) string {
	s = strings.Replace(s, " ", "_", 1)
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' {
			b.WriteByte(c)
		}
	}
	return strings.ToLower(b.String())
}

// textQueryAbsent reports whether a `query` parameter leaves the handler on its database path, as
// if it were absent. `query` is `z.string().optional()` (no trim, no coercion), and the handler
// branches on its truthiness (`if (query)`, `query && page`, `!query ? cursor : undefined`), so only
// the one empty value is falsy. A repeated key is an array, which the schema answers with a 400; a
// blank (`query=%20`) is a truthy text query.
func textQueryAbsent(vals []string) bool {
	return len(vals) == 1 && vals[0] == ""
}

// ParseList parses a `/api/v1/models` query string for a signed-out caller. Every input Node answers
// with a 400, 401 or 429, and every schema key not ported, falls back. A truthy `query` is parsed
// into Text; whether it is answered is the caller's decision (ServeList).
func ParseList(raw string) (*ListInput, error) {
	params, err := feed.ParseSearch(raw)
	if err != nil {
		return nil, fallback.New("v1-models-query-encoding")
	}
	in := &ListInput{Limit: 100, Sort: SortHighestRated, Period: "AllTime", PeriodMode: "published", Query: params}
	for _, p := range params {
		switch {
		case authedOnly[p.Key]:
			// authedOnlyOptions: a signed-out caller naming either is a 401.
			return nil, fallback.New("v1-models-authed-only")
		case p.Key == "query" && !textQueryAbsent(p.Values):
			if len(p.Values) != 1 {
				// A repeated `query` is an array: the schema answers a 400.
				return nil, fallback.New("v1-models-query")
			}
			in.Text = p.Values[0]
		case unported[p.Key]:
			return nil, fallback.New("v1-models-" + p.Key)
		}
	}
	for _, p := range params {
		if !ported[p.Key] {
			continue
		}
		v := p.Values
		switch p.Key {
		case "limit":
			n, err := intParam(v)
			if err != nil {
				return nil, err
			}
			if n == 0 || n > 100 {
				// 0 reads one row and never pages (`take ?? 100` vs `take &&`): not ported; > 100 is a 400.
				return nil, fallback.New("v1-models-limit")
			}
			in.Limit = n
		case "page":
			n, err := intParam(v)
			if err != nil {
				return nil, err
			}
			if n < 1 {
				return nil, fallback.New("v1-models-input-number")
			}
			in.Page = n
		case "cursor":
			s, err := scalar(v)
			if err != nil {
				return nil, err
			}
			in.Cursor = s
		case "sort":
			s, err := scalar(v)
			if err != nil {
				return nil, err
			}
			if !sortsPorted[s] {
				return nil, fallback.New("v1-models-sort")
			}
			in.Sort = s
			in.SortNamed = true
		case "period":
			s, err := scalar(v)
			if err != nil {
				return nil, err
			}
			if !periods[s] {
				return nil, fallback.New("v1-models-input-enum")
			}
			in.Period = s
		case "periodMode":
			s, err := scalar(v)
			if err != nil {
				return nil, err
			}
			if s != "stats" && s != "published" {
				return nil, fallback.New("v1-models-input-enum")
			}
			in.PeriodMode = s
		case "types":
			for _, t := range v {
				if !modelTypes[t] {
					return nil, fallback.New("v1-models-input-enum")
				}
			}
			in.Types = append([]string{}, v...)
		case "status":
			for _, s := range v {
				if !modelStatuses[s] {
					return nil, fallback.New("v1-models-input-enum")
				}
			}
			// A signed-out caller is served Published models whatever `status` names.
		case "baseModels":
			in.BaseModels = append([]string{}, v...)
		case "username":
			s, err := scalar(v)
			if err != nil {
				return nil, err
			}
			in.Username = postgresSlugify(s)
		case "nsfw":
			if in.Nsfw, err = boolParam(p.Key, v); err != nil {
				return nil, err
			}
		case "primaryFileOnly":
			if in.PrimaryFileOnly, err = boolParam(p.Key, v); err != nil {
				return nil, err
			}
		case "earlyAccess":
			if in.EarlyAccess, err = boolParam(p.Key, v); err != nil {
				return nil, err
			}
		case "archived":
			if in.Archived, err = boolParam(p.Key, v); err != nil {
				return nil, err
			}
		case "ids":
			// commaDelimitedNumberArray: one value is split on commas (trimmed), several are taken as
			// they are; each must read as a number.
			parts := v
			if len(v) == 1 {
				parts = strings.Split(v[0], ",")
			}
			ids := make([]int, 0, len(parts))
			for _, s := range parts {
				if len(v) == 1 {
					s = strings.TrimSpace(s)
				}
				if !digits.MatchString(s) {
					return nil, fallback.New("v1-models-ids")
				}
				n, _ := strconv.Atoi(s)
				ids = append(ids, n)
			}
			in.IDs = ids
		case "tag":
			s, err := scalar(v)
			if err != nil {
				return nil, err
			}
			if !feed.IsASCII(s) {
				// The blocked-name test lowercases the name (`toLowerCase`), whose non-ASCII mappings
				// Go's tables do not follow exactly.
				return nil, fallback.New("v1-models-tag")
			}
			in.Tag = s
		}
	}
	usingPaging := in.Page > 0 && in.Cursor == ""
	if usingPaging && in.Page*in.Limit > 1000 {
		return nil, fallback.New("v1-models-page-limit")
	}
	if in.Text != "" {
		if err := parseTextSearch(in); err != nil {
			return nil, err
		}
	}
	return in, nil
}

// parseTextSearch reads what the handler does with a truthy `query`: `query && page` is a 400, and
// the cursor is the search offset (`cursor && Number.isFinite(Number(cursor)) ? Math.max(0,
// Number(cursor)) : 0`). Read here: a cursor of decimal digits (an empty one is no offset). Any other
// cursor Number() reads its own way (a fraction the search refuses, an exponent, a sign, a date the
// cursor schema turns into a Date) falls back. A `baseModels` holding an empty value falls back: the
// schema drops a lone empty value where the statement here would not. Each of these is the one text
// query reason, `v1-models-query`: the request alone decides it, and one reason keeps the
// request-determined set (RequestFallbackReasons) unchanged by the text search.
func parseTextSearch(in *ListInput) error {
	if !utf8.ValidString(in.Text) {
		return fallback.New("v1-models-query-encoding")
	}
	if in.Page > 0 {
		return fallback.New("v1-models-query")
	}
	if in.Cursor != "" {
		if !offsetDigits.MatchString(in.Cursor) {
			return fallback.New("v1-models-query")
		}
		in.TextOffset, _ = strconv.Atoi(in.Cursor)
	}
	if slices.Contains(in.BaseModels, "") {
		return fallback.New("v1-models-query")
	}
	return nil
}

// ParseID is `/api/v1/models/[id]`'s schema: `z.coerce.number().int().gt(0).lte(INT4_MAX)` over the
// path segment. Only decimal digits are read (Number() agrees with them, leading zeros included).
func ParseID(segment string) (int, error) {
	if segment == "" || len(segment) > 20 {
		return 0, fallback.New("v1-models-id")
	}
	for i := 0; i < len(segment); i++ {
		if !isDigit(segment[i]) {
			return 0, fallback.New("v1-models-id")
		}
	}
	n, err := strconv.ParseInt(segment, 10, 64)
	if err != nil || n <= 0 || n > int4Max {
		return 0, fallback.New("v1-models-id")
	}
	return int(n), nil
}
