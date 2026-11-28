package feed

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feedsvc"
	"github.com/civitai/civitai/apps/feed-go/internal/inputschema"
	"github.com/civitai/civitai/apps/feed-go/internal/jskeys"
)

// QueryParam is one key of Next's `req.query`: its values in order (a repeated key collects them).
type QueryParam struct {
	Key    string
	Values []string
}

// V1Input is the `/api/v1/images` query (imagesEndpointSchema in src/server/schema/images-endpoint.schema.ts)
// for the supported subset, after the schema's defaults and transforms.
type V1Input struct {
	Limit          int // 0-200, default 100
	Page           int // 0 = absent (falsy)
	PostID         int
	ModelID        int
	ModelVersionID int
	UserID         int
	Username       string // "" = absent (falsy)
	Period         string
	Sort           string
	// BrowsingLevel and Nsfw are the schema's two maturity inputs; nil = undefined.
	BrowsingLevel *int
	Nsfw          *int
	Cursor        string // "" = none (the REST cursor always parses as a string)
	Type          string // "" = none
	RequiringMeta bool
	// IDs is the `ids` batch as sent (duplicates kept; 1 to imageIDsBatchMax positive ids). A batch
	// takes the legacy Postgres path (runImageSearch's useLegacyMethod).
	IDs []int
	// ImageID is `imageId` (0 = absent; read only with V1Ports.ImageID). It takes the legacy Postgres
	// path too, as does a ModelID without a ModelVersionID (V1Ports.ModelOnly): Legacy.
	ImageID int
	// WithMeta adds each image's cached `meta`; FlatMeta is `flatMeta` (nil = undefined: flat on the
	// feed path, wrapped as `{id, meta}` on the legacy path).
	WithMeta bool
	FlatMeta *bool
	// Query is req.query in Object.keys order, for nextPage.
	Query []QueryParam
}

// V1Ports are the switches of the `/api/v1/images` shapes ported behind one (DESIGN.md §13.2.1). Off,
// the shape falls back with the reason it had before its port.
type V1Ports struct {
	// ImageID is FEED_GO_V1_IMAGES_SERVE_IMAGE_ID: answer an `imageId` on the legacy path instead of the
	// `v1-image-id` fallback.
	ImageID bool
	// ModelOnly is FEED_GO_V1_IMAGES_SERVE_MODEL_ONLY: answer a `modelId` without a `modelVersionId` on
	// the legacy path instead of the `v1-model-only` fallback.
	ModelOnly bool
}

// Legacy is runImageSearch's useLegacyMethod on this route (`postOrder` is the posts route's only):
// an `ids` batch, a truthy `imageId`, or a truthy `modelId` without a truthy `modelVersionId` read
// getAllImages itself instead of the feed.
func (in *V1Input) Legacy() bool {
	return len(in.IDs) > 0 || in.ImageID != 0 || (in.ModelID != 0 && in.ModelVersionID == 0)
}

// imageIDsBatchMax is IMAGE_IDS_BATCH_MAX (src/server/common/constants.ts): the most ids one `ids`
// batch may name.
const imageIDsBatchMax = 100

// v1Schema is imagesEndpointSchema's allow-list and defaults (why: the inputschema package doc); `token`,
// the API key Resolve hands to the app, is also allowed.
var v1Schema = inputschema.Get(inputschema.ImagesEndpoint)

var v1TransportKeys = map[string]bool{"token": true}

// v1Defaults are imagesEndpointSchema's defaults, decoded once at package init.
var v1Defaults = struct{ period, sort string }{
	period: v1Schema.DefaultString("period"), sort: v1Schema.DefaultString("sort"),
}

// v1ParsedKeys are the schema keys ParseV1 reads: every one (TestInputKeyLedger), so a key added to
// the schema must be ported or made a fallback.
var v1ParsedKeys = []string{
	"limit", "page", "postId", "modelId", "modelVersionId", "imageId", "ids", "username", "userId",
	"period", "sort", "nsfw", "browsingLevel", "tags", "cursor", "type", "baseModels", "withMeta",
	"requiringMeta", "flatMeta", "withTags",
}

var (
	v1Periods  = map[string]bool{"Day": true, "Week": true, "Month": true, "Year": true, "AllTime": true}
	v1Types    = map[string]bool{"image": true, "video": true, "audio": true}
	digitsRE   = regexp.MustCompile(`^[0-9]{1,10}$`)
	usernameRE = regexp.MustCompile(`^[A-Za-z0-9_]*$`)
)

// v1Sorts are the ImageSort values the feed service serves. Every other sort is answered with a 400 on
// this route (the mapper's `sort:` refusal), so it is never sampled; it falls back here.
var v1Sorts = map[string]bool{
	SortMostReactions: true, SortMostComments: true, SortMostCollected: true, SortNewest: true, SortOldest: true,
}

// nsfwLevelMapDeprecated (src/shared/constants/browsingLevel.constants.ts).
var nsfwDeprecatedLevels = map[string]int{
	"None":    browsing.PG,
	"Soft":    browsing.PG | browsing.PG13,
	"Mature":  browsing.PG | browsing.PG13 | browsing.R,
	"X":       browsing.PG | browsing.PG13 | browsing.R | browsing.X | browsing.XXX,
	"Blocked": browsing.Blocked,
}

// zod's stringbool defaults, compared case-insensitively.
var (
	stringboolTrue  = map[string]bool{"true": true, "1": true, "yes": true, "on": true, "y": true, "enabled": true}
	stringboolFalse = map[string]bool{"false": true, "0": true, "no": true, "off": true, "n": true, "disabled": true}
)

// ParseSearch splits a raw query string as URLSearchParams does (`&`-separated, `+` as a space,
// percent-decoding), then collects it the way Next builds `req.query` (searchParamsToUrlQuery: a
// repeated key becomes an array, in first-seen key order). A malformed escape or a non-UTF-8 value
// falls back: URLSearchParams and Node's querystring disagree there.
func ParseSearch(raw string) ([]QueryParam, error) {
	raw = strings.TrimPrefix(raw, "?")
	var out []QueryParam
	index := map[string]int{}
	for _, seg := range strings.Split(raw, "&") {
		if seg == "" {
			continue
		}
		k, v, _ := strings.Cut(seg, "=")
		key, err := formDecode(k)
		if err != nil {
			return nil, err
		}
		val, err := formDecode(v)
		if err != nil {
			return nil, err
		}
		if i, ok := index[key]; ok {
			out[i].Values = append(out[i].Values, val)
			continue
		}
		index[key] = len(out)
		out = append(out, QueryParam{Key: key, Values: []string{val}})
	}
	return objectKeyOrder(out), nil
}

func formDecode(s string) (string, error) {
	s = strings.ReplaceAll(s, "+", " ")
	if !strings.Contains(s, "%") {
		if !utf8.ValidString(s) {
			return "", fallback.New("v1-query-encoding")
		}
		return s, nil
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '%' {
			b.WriteByte(s[i])
			continue
		}
		if i+2 >= len(s) || !isHex(s[i+1]) || !isHex(s[i+2]) {
			return "", fallback.New("v1-query-encoding")
		}
		n, _ := strconv.ParseUint(s[i+1:i+3], 16, 8)
		b.WriteByte(byte(n))
		i += 2
	}
	out := b.String()
	if !utf8.ValidString(out) {
		return "", fallback.New("v1-query-encoding")
	}
	return out, nil
}

func isHex(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

// objectKeyOrder is Object.keys order (jskeys.Order).
func objectKeyOrder(params []QueryParam) []QueryParam {
	return jskeys.Order(params, func(p QueryParam) string { return p.Key })
}

// ParseV1 is ParseV1With every port off.
func ParseV1(raw string) (*V1Input, error) { return ParseV1With(raw, V1Ports{}) }

// ParseV1With is imagesEndpointSchema.safeParse(req.query) plus the routing runImageSearch does, for
// the supported subset and the shapes ports turns on. Shapes not ported, and every input Node answers
// with a 400, fall back.
func ParseV1With(raw string, ports V1Ports) (*V1Input, error) {
	params, err := ParseSearch(raw)
	if err != nil {
		return nil, err
	}
	vals := map[string]string{}
	for _, p := range params {
		if !v1Schema.Has(p.Key) {
			continue
		}
		if len(p.Values) > 1 {
			// An array reaches a scalar schema member: a 400.
			return nil, fallback.New("v1-input-duplicate")
		}
		vals[p.Key] = p.Values[0]
	}
	has := func(k string) bool { _, ok := vals[k]; return ok }

	// Shapes taking a path this service does not port (or ports behind a switch that is off).
	switch {
	case has("imageId") && !ports.ImageID:
		return nil, fallback.New("v1-image-id")
	case has("tags"):
		return nil, fallback.New("v1-tags")
	case has("baseModels"):
		return nil, fallback.New("v1-base-models")
	}
	// After unsupported keys so the reason names the parity gap (the app's shape counter uses this order).
	keys := make([]string, 0, len(params))
	for _, p := range params {
		keys = append(keys, p.Key)
	}
	if k, ok := v1Schema.Unknown(keys, v1TransportKeys); ok {
		return nil, fallback.NewfSafe("input-unknown-key", fallback.Token(k), "%s", k)
	}

	// The limit's default is not in the projection (numericString's preprocess hides it); it is the
	// same constants.galleryFilterDefaults.limit as getInfiniteImagesSchema's.
	in := &V1Input{Limit: imagesDefaults.limit, Period: v1Defaults.period, Sort: v1Defaults.sort, Query: params}
	num := func(k string, dst *int) error {
		v, ok := vals[k]
		if !ok {
			return nil
		}
		n, err := v1Int(v)
		if err != nil {
			return err
		}
		*dst = n
		return nil
	}
	for k, dst := range map[string]*int{
		"limit": &in.Limit, "page": &in.Page, "postId": &in.PostID, "modelId": &in.ModelID,
		"modelVersionId": &in.ModelVersionID, "userId": &in.UserID, "imageId": &in.ImageID,
	} {
		if err := num(k, dst); err != nil {
			return nil, err
		}
	}
	if in.Limit > 200 {
		return nil, fallback.New("v1-input-number")
	}
	if has("userId") && in.UserID == 0 {
		// `userId=0` is not nullish, so no username is looked up for the feed, while getAllImages
		// still resolves the username for the hydrate: not ported.
		return nil, fallback.New("v1-user-zero")
	}
	if has("imageId") && in.ImageID == 0 {
		// `imageId=0` is falsy to runImageSearch (no legacy path) yet a present key to the feed query
		// mapper, which refuses it (an empty page, a 400 beside a feed cursor): not ported, so it stays
		// the shape's fallback with the switch on.
		return nil, fallback.New("v1-image-id")
	}
	if in.ModelID != 0 && in.ModelVersionID == 0 && !ports.ModelOnly {
		// A modelId without a version takes the legacy Postgres path (served with ports.ModelOnly).
		return nil, fallback.New("v1-model-only")
	}
	if v, ok := vals["username"]; ok {
		if !usernameRE.MatchString(v) {
			return nil, fallback.New("v1-input-username")
		}
		in.Username = v
	}
	if v, ok := vals["period"]; ok {
		if !v1Periods[v] {
			return nil, fallback.New("v1-input-period")
		}
		in.Period = v
	}
	if v, ok := vals["sort"]; ok {
		if !v1Sorts[v] {
			return nil, fallback.New("v1-sort")
		}
		in.Sort = v
	}
	if v, ok := vals["nsfw"]; ok {
		if lvl, ok := nsfwDeprecatedLevels[v]; ok {
			in.Nsfw = &lvl
		} else {
			b, err := stringbool(v)
			if err != nil {
				return nil, err
			}
			if b {
				lvl := browsing.NSFWLevels
				in.Nsfw = &lvl
			}
		}
	}
	if v, ok := vals["browsingLevel"]; ok {
		n, err := v1Int(v)
		if err != nil {
			return nil, err
		}
		in.BrowsingLevel = &n
	}
	if v, ok := vals["ids"]; ok {
		if in.IDs, err = v1IDs(v); err != nil {
			return nil, err
		}
	}
	in.Cursor = vals["cursor"]
	if v, ok := vals["type"]; ok {
		if !v1Types[v] {
			return nil, fallback.New("v1-input-type")
		}
		in.Type = v
	}
	bools := map[string]*bool{}
	var withTags, flatMeta bool
	bools["withMeta"], bools["withTags"], bools["flatMeta"], bools["requiringMeta"] = &in.WithMeta, &withTags, &flatMeta, &in.RequiringMeta
	for k, dst := range bools {
		if v, ok := vals[k]; ok {
			b, err := stringbool(v)
			if err != nil {
				return nil, err
			}
			*dst = b
		}
	}
	if has("flatMeta") {
		in.FlatMeta = &flatMeta
	}
	if withTags {
		return nil, fallback.New("v1-with-tags")
	}
	return in, nil
}

// v1Int accepts the plain decimal integers numericString turns into the same integer; anything Number()
// reads otherwise (fractions, exponents, hex, blanks, signs) falls back.
func v1Int(v string) (int, error) {
	if !digitsRE.MatchString(v) {
		return 0, fallback.New("v1-input-number")
	}
	n, err := strconv.Atoi(v)
	if err != nil || n > 1<<31-1 {
		return 0, fallback.New("v1-input-number")
	}
	return n, nil
}

// v1IDs is commaDelimitedNumberArray(z.number().int().positive().array().min(1).max(100)) for the
// spellings that read the same in Go: split on `,`, each part trimmed, every part a plain decimal
// integer from 1 to 2^31-1. Number() reads more (hex, exponents, a fraction of .0, `+1`) and the
// schema takes those too, so they fall back rather than being refused; so do ids past int4, which
// zod accepts and Postgres then rejects.
func v1IDs(v string) ([]int, error) {
	parts := strings.Split(v, ",")
	if len(parts) > imageIDsBatchMax {
		return nil, fallback.New("v1-input-ids")
	}
	ids := make([]int, 0, len(parts))
	for _, p := range parts {
		// String.prototype.trim also strips Unicode spaces; a part carrying one is not all digits
		// after this ASCII trim, so it falls back.
		n, err := v1Int(strings.Trim(p, " \t\n\v\f\r"))
		if err != nil || n < 1 {
			return nil, fallback.New("v1-input-ids")
		}
		ids = append(ids, n)
	}
	return ids, nil
}

func stringbool(v string) (bool, error) {
	l := strings.ToLower(v)
	switch {
	case stringboolTrue[l]:
		return true, nil
	case stringboolFalse[l]:
		return false, nil
	}
	return false, fallback.New("v1-input-bool")
}

// AssertFeedOffsetCursor is runImageSearch's assertFeedOffsetCursor: a cursor that is neither the feed's
// own nor an `<offset>[|<anything>]` in range is a 400 (a fallback here).
func AssertFeedOffsetCursor(cursor string) error {
	if cursor == "" {
		return nil
	}
	if feedsvc.ParseCursor(cursor) != "" {
		return nil
	}
	m := feedOffsetCursorRE.FindStringSubmatch(cursor)
	if m == nil {
		return fallback.New("v1-cursor")
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil || n < 0 || n > 1<<31-1 {
		return fallback.New("v1-cursor")
	}
	return nil
}

var feedOffsetCursorRE = regexp.MustCompile(`^(-?\d+)(?:\|[^|]*)?$`)

// StrictURIEncode is query-string's strict encoding: encodeURIComponent, then `!'()*` escaped too.
func StrictURIEncode(s string) string {
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&15])
	}
	return b.String()
}

// QSStringify is QS.stringify (src/utils/qs.ts: query-string with skipEmptyString, skipNull, sort false)
// for req.query-shaped values: each value `key=value`, an empty string skipped, keys in order.
func QSStringify(params []QueryParam) string {
	var parts []string
	for _, p := range params {
		for _, v := range p.Values {
			if v == "" {
				continue
			}
			parts = append(parts, StrictURIEncode(p.Key)+"="+StrictURIEncode(v))
		}
	}
	return strings.Join(parts, "&")
}

// withParam sets key to value, in place when present (a JS property assignment keeps its position),
// else appended — then re-applies Object.keys order (an array-index key moves forward).
func withParam(params []QueryParam, key, value string) []QueryParam {
	out := make([]QueryParam, 0, len(params)+1)
	found := false
	for _, p := range params {
		if p.Key == key {
			out = append(out, QueryParam{Key: key, Values: []string{value}})
			found = true
			continue
		}
		out = append(out, p)
	}
	if !found {
		out = append(out, QueryParam{Key: key, Values: []string{value}})
	}
	return objectKeyOrder(out)
}
