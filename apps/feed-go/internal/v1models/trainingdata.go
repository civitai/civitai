package v1models

import (
	"context"
	_ "embed" // the training-data statement
	"encoding/json"
	"math"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// Training Data files in the public model bodies: trainingDataListing
// (src/server/services/training-data-restricted.service.ts), which both routes apply — the list inside
// its shaper (runModelSearch), `[id]` to the body after the origin cache (withListableTrainingData in
// src/pages/api/v1/models/[id].ts), since that cache keys on neither the host nor a restriction placed
// since. A file Node leaves out is never listed here: every refusal is read from the same statement
// and decided by the same predicate, and what cannot be decided falls back.

const trainingDataType = "Training Data"

// trainingDataListingSQL is trainingDataListing's statement, byte for byte as Node's builder renders
// it (trainingDataOwnerRestrictedSql over ownerHeldSql, and trainingDataContentRestrictedSql), with the
// candidate version ids as $1. The golden fixtures hold it to the statement the Node route sends, and
// src/server/services/__tests__/feed-go-training-data-listing.parity.test.ts holds it to Node's
// builder and runs it on Postgres, one case per refusal reason. Change it only by re-rendering it.
//
//go:embed training_data_listing.sql
var trainingDataListingSQL string

// trainingDataFilter is trainingDataListing's predicate: a Training Data file whose row it refused
// is left out; every other file is listed. A nil filter lists everything.
type trainingDataFilter struct {
	refused map[float64]bool
}

// listed is `(file) => !(file.type === 'Training Data' && refused.has(file.id))`.
func (f *trainingDataFilter) listed(file superjson.Object) bool {
	if f == nil {
		return true
	}
	if t, _ := getVal(file, "type").(string); t != trainingDataType {
		return true
	}
	id, ok := numberOf(getVal(file, "id"))
	return !ok || !f.refused[id]
}

// trainingDataListing reads the rows of the Training Data files of every version listing one (the
// `candidates`), and refuses each row trainingDataRefused refuses. No candidate: nothing is read and
// everything is listed. Node fails closed when the read fails (every Training Data file left out);
// whether Node's own read failed is not known here, so a failed read falls back instead: no answer
// can then list a file Node left out, nor differ from Node's.
func (d *Deps) trainingDataListing(ctx context.Context, versions []superjson.Object, host string) (*trainingDataFilter, error) {
	var candidates []int
	for _, v := range versions {
		files, err := versionFiles(v)
		if err != nil {
			return nil, err
		}
		has := false
		for _, f := range files {
			if t, _ := getVal(f, "type").(string); t == trainingDataType {
				has = true
				break
			}
		}
		if !has {
			continue
		}
		id, ok := intOf(getVal(v, "id"))
		if !ok {
			return nil, fallback.New("v1-models-training-data")
		}
		candidates = append(candidates, id)
	}
	if len(candidates) == 0 {
		return nil, nil
	}
	rows, err := queryRows(ctx, d.DB, trainingDataListingSQL, candidates)
	if err != nil {
		return nil, fallback.Wrap("v1-models-training-data-unread", err)
	}
	out := &trainingDataFilter{refused: map[float64]bool{}}
	redKnown, red := false, false
	for _, r := range rows {
		id, ok := numberOf(r["id"])
		if !ok {
			return nil, fallback.New("v1-models-training-data")
		}
		refused := trainingDataRowRefused(r)
		if !refused {
			if !redKnown {
				if red, err = d.redCapable(host); err != nil {
					return nil, err
				}
				redKnown = true
			}
			refused = !trainingDataServableOnHost(r["nsfwLevel"], r["fullyRated"], red)
		}
		if refused {
			out.refused[id] = true
		}
	}
	return out, nil
}

// trainingDataRowRefused is the row's own half of the refusal: `r.restricted !== false` (a restricted
// owner or content, and NULL, which the statement yields when it cannot say) or
// `r.virusScanResult !== ScanResultCode.Success`.
func trainingDataRowRefused(r map[string]any) bool {
	if b, ok := r["restricted"].(bool); !ok || b {
		return true
	}
	s, ok := textOf(r["virusScanResult"])
	return !ok || s != "Success"
}

// trainingDataServableOnHost is trainingDataServableOnHost (src/shared/utils/training-data-visibility.ts)
// over the row's `metadata -> 'nsfwLevel'` and `metadata -> 'fullyRated'` (jsonb, as JSON values):
// any file on a red-capable host; elsewhere not one whose `fullyRated` is the boolean false, nor one
// whose `nsfwLevel` is a number with a bit outside PG|PG-13 (`(level & ~sfwBrowsingLevelsFlag) === 0`,
// JS's 32-bit `&`). A level that is not a number is servable.
func trainingDataServableOnHost(nsfwLevel, fullyRated any, redCapable bool) bool {
	if redCapable {
		return true
	}
	if b, ok := fullyRated.(bool); ok && !b {
		return false
	}
	level, ok := jsonNumber(nsfwLevel)
	if !ok {
		return true
	}
	// ToInt32(level) & ~3 is 0 exactly when ToUint32(level) is 0..3.
	return jsToUint32(level) < 4
}

// jsToUint32 is ECMAScript's ToUint32, as a float64 in [0, 2^32).
func jsToUint32(f float64) float64 {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	m := math.Mod(math.Trunc(f), 1<<32)
	if m < 0 {
		m += 1 << 32
	}
	return m
}

// jsonNumber reads a jsonb value as JS's typeof === 'number' would: a JSON number.
func jsonNumber(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case float32:
		return float64(t), true
	case json.Number:
		f, err := t.Float64()
		return f, err == nil
	case int, int8, int16, int32, int64, uint8, uint16, uint32, uint64:
		return numberOf(t)
	}
	return 0, false
}

// textOf reads a text (or enum) column.
func textOf(v any) (string, bool) {
	switch t := v.(type) {
	case string:
		return t, true
	case []byte:
		return string(t), true
	}
	return "", false
}

// versionFiles is a version's `files` as the listing reads it: absent or null is none; anything but
// an array of objects is a value the Node code would throw on.
func versionFiles(v superjson.Object) ([]superjson.Object, error) {
	raw, _ := v.Get("files")
	switch t := raw.(type) {
	case nil, superjson.Undefined:
		return nil, nil
	case []any:
		out := make([]superjson.Object, 0, len(t))
		for _, f := range t {
			o, ok := f.(superjson.Object)
			if !ok {
				return nil, fallback.New("v1-models-training-data")
			}
			out = append(out, o)
		}
		return out, nil
	}
	return nil, fallback.New("v1-models-training-data")
}

// redCapable is isRedCapableHost (src/server/utils/server-domain.ts): the request's Host header,
// lowercased and NOT stripped of a port, is SERVER_DOMAIN_RED or one of its aliases (Config.RedHosts).
// An empty host is not. Non-ASCII text on either side falls back: Go's lowercasing of it is not
// always JS's toLowerCase.
func (d *Deps) redCapable(host string) (bool, error) {
	if host == "" {
		return false, nil
	}
	if !isASCII(host) {
		return false, fallback.New("v1-models-host")
	}
	for _, h := range d.Config.RedHosts {
		if !isASCII(h) {
			return false, fallback.New("v1-models-host")
		}
	}
	lower := strings.ToLower(host)
	for _, h := range d.Config.RedHosts {
		if h == lower {
			return true, nil
		}
	}
	return false, nil
}

// RedHosts is the red domain's host list as isHostForColor reads it: none unless SERVER_DOMAIN_RED is
// set (buildConfig), else that primary lowercased (not trimmed) and each alias trimmed, lowercased
// and non-empty. hosts is the primary followed by the aliases as the config read them
// (config.Hosts["red"]).
func RedHosts(primary string, hosts []string) []string {
	if primary == "" {
		return nil
	}
	out := []string{strings.ToLower(primary)}
	for _, h := range hosts {
		if h == primary {
			continue
		}
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			out = append(out, h)
		}
	}
	return out
}

// withListableTrainingData is the `[id]` route's `{ ...body, modelVersions: versions.map((v) =>
// v.files ? { ...v, files: v.files.filter(listed) } : v) }` over `body.modelVersions ?? []`: a body
// without `modelVersions` gains an empty one, at its end. Applied to a built body and to a cached one
// alike.
func (d *Deps) withListableTrainingData(ctx context.Context, body superjson.Object, host string) (superjson.Object, error) {
	raw, _ := body.Get("modelVersions")
	var list []any
	switch t := raw.(type) {
	case nil, superjson.Undefined:
		list = []any{}
	case []any:
		list = t
	default:
		return nil, fallback.New("v1-models-training-data")
	}
	versions := make([]superjson.Object, len(list))
	for i, v := range list {
		o, ok := v.(superjson.Object)
		if !ok {
			return nil, fallback.New("v1-models-training-data")
		}
		versions[i] = o
	}
	filter, err := d.trainingDataListing(ctx, versions, host)
	if err != nil {
		return nil, err
	}
	out := make([]any, len(versions))
	for i, v := range versions {
		files, err := versionFiles(v)
		if err != nil {
			return nil, err
		}
		if raw, _ := v.Get("files"); !isArray(raw) {
			// `v.files` is absent (versionFiles refused anything else): the version as it is.
			out[i] = v
			continue
		}
		kept := make([]any, 0, len(files))
		for _, f := range files {
			if filter.listed(f) {
				kept = append(kept, f)
			}
		}
		nv := cloneObject(v)
		nv.Set("files", kept)
		out[i] = nv
	}
	res := cloneObject(body)
	res.Set("modelVersions", out)
	return res, nil
}

func isArray(v any) bool {
	_, ok := v.([]any)
	return ok
}
