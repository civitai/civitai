package v1models

import (
	"context"
	"crypto/sha256"
	_ "embed" // the training-data statement
	"encoding/hex"
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/feed"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
)

// Training Data files in the public model bodies: trainingDataListing
// (src/server/services/training-data-restricted.service.ts), which both routes apply — the list inside
// its shaper (runModelSearch), `[id]` to the body after the origin cache (withListableTrainingData in
// src/pages/api/v1/models/[id].ts), since that cache keys on neither the host nor a restriction placed
// since. A file Node leaves out is never listed here: every refusal is read from the same statement
// and decided by the same predicate, and what cannot be decided falls back.

const trainingDataType = "Training Data"

// trainingDataListingSQL is trainingDataListingSql's text (training-data-restricted.service.ts), byte
// for byte as Node renders it (trainingDataOwnerRestrictedSql over ownerHeldSql, and
// trainingDataContentRestrictedSql), with the candidate version ids as $1. The golden fixtures hold it
// to the statement the Node route sends, and
// src/server/services/__tests__/feed-go-training-data-listing.parity.test.ts holds it to Node's
// builder (exact bytes) and runs it on Postgres, one case per refusal reason. Change it only by
// re-rendering it.
//
//go:embed training_data_listing.sql
var trainingDataListingSQL string

// TrainingDataRulesVersion is the version of the decision over the rows this build ports
// (trainingDataRowRefused, trainingDataServableOnHost, the listed predicate): Node's
// TRAINING_DATA_LISTING_RULES_VERSION (training-data-restricted.service.ts), which
// feed-go-training-data-listing.parity.test.ts holds to the Node source it versions and to this
// constant. Bump both when Node's decision changes, and port the change here in the same PR.
const TrainingDataRulesVersion = 1

// TrainingDataSQLHash is the rule set this build lists Training Data files by, as Node names its own
// (trainingDataListingRulesId, header TrainingDataSQLHeader): the SHA-256 (hex) of
// trainingDataListingSQL and the decision's version, `<sha256>;rules=<n>`. A body with a Training
// Data candidate is answered only when the sample's value equals it, so a Node deploy that changes
// the statement or the decision (or a sample that does not say) makes feed-go fall back rather than
// list by rules the Node it shadows no longer has.
var TrainingDataSQLHash = func() string {
	sum := sha256.Sum256([]byte(trainingDataListingSQL))
	return hex.EncodeToString(sum[:]) + ";rules=" + strconv.Itoa(TrainingDataRulesVersion)
}()

// TrainingDataSQLHeader carries Node's rule set id on a model sample (feed-go-shadow.ts).
const TrainingDataSQLHeader = "x-feed-go-training-data-sql"

// listingRequest is what the listing reads from the request: its Host header (isRedCapableHost) and
// the Node rule-set id the sample carried ("" = none).
type listingRequest struct {
	host, sqlHash string
}

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
func (d *Deps) trainingDataListing(ctx context.Context, versions []superjson.Object, req listingRequest) (*trainingDataFilter, error) {
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
	if req.sqlHash != TrainingDataSQLHash {
		// Not the rules the Node this answers for applies (or it did not say): fall back.
		return nil, fallback.New("v1-models-training-data-drift")
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
				if red, err = d.redCapable(req.host); err != nil {
					return nil, err
				}
				redKnown = true
			}
			servable, err := trainingDataServableOnHost(r["nsfwLevel"], r["fullyRated"], red)
			if err != nil {
				return nil, err
			}
			refused = !servable
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
// JS's 32-bit `&`). A level that is not a number is servable. A value of a type a jsonb read does not
// produce falls back.
func trainingDataServableOnHost(nsfwLevel, fullyRated any, redCapable bool) (bool, error) {
	if redCapable {
		return true, nil
	}
	if b, ok := fullyRated.(bool); ok && !b {
		return false, nil
	}
	level, isNumber, err := jsonNumber(nsfwLevel)
	if err != nil || !isNumber {
		return err == nil, err
	}
	// ToInt32(level) and ToUint32(level) have the same 32 bits.
	return uint32(jsToUint32(level))&^uint32(browsing.SFWLevels) == 0, nil
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

// jsonNumber reads a jsonb value as JS's typeof === 'number' would: whether it is a JSON number, and
// its value. pgx decodes jsonb as encoding/json does (float64, string, bool, nil, map, slice); any
// other Go type is a decoding this port does not know, and falls back rather than guess.
func jsonNumber(v any) (float64, bool, error) {
	switch t := v.(type) {
	case float64:
		return t, true, nil
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return 0, false, fallback.New("v1-models-training-data")
		}
		return f, true, nil
	case nil, string, bool, map[string]any, []any:
		return 0, false, nil
	}
	return 0, false, fallback.New("v1-models-training-data")
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
	if !feed.IsASCII(host) {
		return false, fallback.New("v1-models-host")
	}
	for _, h := range d.Config.RedHosts {
		if !feed.IsASCII(h) {
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
// and non-empty. primary is config.HostPrimaries["red"] (already lowercased) and hosts is
// config.Hosts["red"]: the raw primary followed by the aliases, so the entry equal to the primary
// once both are lowercased is the primary itself.
func RedHosts(primary string, hosts []string) []string {
	if primary == "" {
		return nil
	}
	p := strings.ToLower(primary)
	out := []string{p}
	for _, h := range hosts {
		if strings.ToLower(h) == p {
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
func (d *Deps) withListableTrainingData(ctx context.Context, body superjson.Object, req listingRequest) (superjson.Object, error) {
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
	filter, err := d.trainingDataListing(ctx, versions, req)
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
