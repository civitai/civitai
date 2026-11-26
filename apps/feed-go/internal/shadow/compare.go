// Package shadow compares this service's answer with the Node app's for the same request.
//
// Both sides are superjson envelopes `{json, meta}`. The comparison is on DECODED values, which is what
// the client renders: `json` trees compared structurally (object key order ignored, array order kept)
// after the ["undefined"] annotations are applied as superjson.deserialize applies them (Node writes
// an undefined member as `null` + annotation, and so does this service's writer; one that omits the
// member, as it did before 0.0.51, decodes to the same undefined), and the
// `meta.values` annotation sets compared as sets (a Date annotated on one side only is a type
// difference the client would see). `meta.referentialEqualities` is ignored: it changes object identity
// after decode, never a value.
package shadow

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/big"
	"sort"
	"strconv"
	"strings"
)

// Diff is one differing path.
type Diff struct {
	Path     string // concrete path, e.g. items.3.images.0.stats.likeCountAllTime
	Category string // path with indices folded to `*` and opaque subtrees truncated (metric label)
	Kind     string // value | missing-in-go | missing-in-node | type | length | annotation
}

// Report is the outcome of one comparison.
type Report struct {
	Match bool
	Diffs []Diff
	// Truncated is true when more than MaxDiffs differences existed.
	Truncated bool
	// opaque is the key set a category stops at (nil = the superjson envelope's).
	opaque map[string]bool
	// unordered is the categories whose arrays of numbers are compared as multisets (nil = none).
	unordered map[string]bool
}

// MaxDiffs bounds the differences collected per comparison.
const MaxDiffs = 64

// opaque keys: their subtrees are free-form JSON (image metadata, cosmetic data), so a category stops
// there and metric label cardinality stays bounded by the response schema.
var opaque = map[string]bool{"metadata": true, "data": true, "remixOfId": true}

// v1ImagesUnordered is CompareV1Images' multiset categories. `modelVersionIds` is an image's detected
// model versions in the image-resources cache's order, which the public images endpoint never
// promised. A miss each side computes for itself came out in whatever order its plan returned until
// both lookups carried the same ORDER BY, and does again while the two sides run different releases
// of it, so the same ids came out permuted. The ids themselves are still compared, as a multiset (a
// missing, extra or repeated id is a difference). Nothing else is compared unordered: `baseModel` (the
// first Checkpoint in cached order) keeps its exact compare.
var v1ImagesUnordered = map[string]bool{"items.*.modelVersionIds": true}

// jsonOpaque is the opaque set of the plain-JSON REST responses (CompareJSON). Their `metadata` is the
// page's paging object (nextCursor, nextPage, …), not free-form, so it is walked; `meta` (image
// generation metadata, a fallback shape today) is free-form.
var jsonOpaque = map[string]bool{"meta": true}

type envelope struct {
	JSON json.RawMessage `json:"json"`
	Meta *struct {
		Values json.RawMessage `json:"values"`
	} `json:"meta"`
}

// Compare compares two superjson envelopes (Go's, Node's).
func Compare(goEnv, nodeEnv []byte) (*Report, error) {
	var g, n envelope
	if err := json.Unmarshal(goEnv, &g); err != nil {
		return nil, fmt.Errorf("go envelope: %w", err)
	}
	if err := json.Unmarshal(nodeEnv, &n); err != nil {
		return nil, fmt.Errorf("node envelope: %w", err)
	}
	gv, err := decode(g.JSON)
	if err != nil {
		return nil, fmt.Errorf("go json: %w", err)
	}
	nv, err := decode(n.JSON)
	if err != nil {
		return nil, fmt.Errorf("node json: %w", err)
	}
	ga, err := annotations(g.Meta)
	if err != nil {
		return nil, err
	}
	na, err := annotations(n.Meta)
	if err != nil {
		return nil, err
	}
	gv = applyUndefined(gv, ga)
	nv = applyUndefined(nv, na)
	r := &Report{}
	walk(r, gv, nv, nil)
	compareAnnotations(r, ga, na)
	r.Match = len(r.Diffs) == 0 && !r.Truncated
	return r, nil
}

// undefinedValue is a decoded `undefined`: what superjson.deserialize leaves at a path annotated
// ["undefined"].
type undefinedValue struct{}

// applyUndefined does what superjson's applyValueAnnotations does for the ["undefined"] annotations:
// it sets each annotated path to undefined (setDeep assigns `parent[lastKey]` unconditionally, so the
// key exists after decode whether or not the json carried it). superjson.serialize writes an
// undefined object member as `null` plus the annotation, as this service's writer now does too; a
// writer that omits the member (this one before 0.0.51) and writes the same annotation decodes to
// the same object, so the raw json alone must not be
// compared at those paths. Every other annotation (Date) leaves the json value as is; the annotation
// sets are compared separately.
func applyUndefined(v any, ann map[string]string) any {
	paths := make([]string, 0, len(ann))
	for p, typ := range ann {
		if typ == "undefined" {
			paths = append(paths, p)
		}
	}
	sort.Strings(paths)
	for _, p := range paths {
		if p == "" {
			return undefinedValue{}
		}
		segs := splitPath(p)
		parent := v
		for _, seg := range segs[:len(segs)-1] {
			parent = child(parent, seg)
		}
		last := segs[len(segs)-1]
		switch t := parent.(type) {
		case map[string]any:
			t[last] = undefinedValue{}
		case []any:
			if i, err := strconv.Atoi(last); err == nil && i >= 0 && i < len(t) {
				t[i] = undefinedValue{}
			}
		}
	}
	return v
}

func child(v any, seg string) any {
	switch t := v.(type) {
	case map[string]any:
		return t[seg]
	case []any:
		if i, err := strconv.Atoi(seg); err == nil && i >= 0 && i < len(t) {
			return t[i]
		}
	}
	return nil
}

func decode(raw json.RawMessage) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	err := dec.Decode(&v)
	return v, err
}

func annotations(meta *struct {
	Values json.RawMessage `json:"values"`
}) (map[string]string, error) {
	out := map[string]string{}
	if meta == nil || len(meta.Values) == 0 {
		return out, nil
	}
	var flat map[string][]any
	if err := json.Unmarshal(meta.Values, &flat); err != nil {
		// A root-level annotation (`["Date"]`) is not a path map.
		var root []any
		if json.Unmarshal(meta.Values, &root) == nil && len(root) > 0 {
			out[""] = fmt.Sprint(root[0])
			return out, nil
		}
		return nil, fmt.Errorf("meta.values: %w", err)
	}
	for path, ann := range flat {
		if len(ann) > 0 {
			out[path] = fmt.Sprint(ann[0])
		}
	}
	return out, nil
}

func compareAnnotations(r *Report, g, n map[string]string) {
	keys := map[string]bool{}
	for k := range g {
		keys[k] = true
	}
	for k := range n {
		keys[k] = true
	}
	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)
	for _, k := range sorted {
		if g[k] != n[k] {
			add(r, splitPath(k), "annotation")
		}
	}
}

// splitPath reverses superjson's escaped dotted path.
func splitPath(p string) []string {
	var out []string
	var cur strings.Builder
	for i := 0; i < len(p); i++ {
		c := p[i]
		if c == '\\' && i+1 < len(p) {
			cur.WriteByte(p[i+1])
			i++
			continue
		}
		if c == '.' {
			out = append(out, cur.String())
			cur.Reset()
			continue
		}
		cur.WriteByte(c)
	}
	return append(out, cur.String())
}

func add(r *Report, path []string, kind string) {
	if len(r.Diffs) >= MaxDiffs {
		r.Truncated = true
		return
	}
	r.Diffs = append(r.Diffs, Diff{Path: strings.Join(path, "."), Category: category(path, r.opaqueSet()), Kind: kind})
}

// opaqueSet is the key set r's categories stop at.
func (r *Report) opaqueSet() map[string]bool {
	if r.opaque == nil {
		return opaque
	}
	return r.opaque
}

// Category folds array indices to `*` and truncates at the first opaque key.
func Category(path []string) string { return category(path, opaque) }

func category(path []string, opaque map[string]bool) string {
	out := make([]string, 0, len(path))
	for _, seg := range path {
		if _, err := strconv.Atoi(seg); err == nil {
			out = append(out, "*")
			continue
		}
		out = append(out, seg)
		if opaque[seg] {
			break
		}
	}
	return strings.Join(out, ".")
}

func walk(r *Report, g, n any, path []string) {
	if r.Truncated {
		return
	}
	switch gt := g.(type) {
	case map[string]any:
		nt, ok := n.(map[string]any)
		if !ok {
			add(r, path, "type")
			return
		}
		keys := make([]string, 0, len(gt)+len(nt))
		for k := range gt {
			keys = append(keys, k)
		}
		for k := range nt {
			if _, ok := gt[k]; !ok {
				keys = append(keys, k)
			}
		}
		sort.Strings(keys)
		for _, k := range keys {
			child := append(append([]string(nil), path...), k)
			gv, gok := gt[k]
			nv, nok := nt[k]
			_, gUndef := gv.(undefinedValue)
			_, nUndef := nv.(undefinedValue)
			switch {
			case (!gok && nUndef) || (!nok && gUndef):
				// Absent on one side, undefined on the other: the same value after decode, and the
				// one-sided ["undefined"] annotation is already reported by compareAnnotations.
			case !gok:
				add(r, child, "missing-in-go")
			case !nok:
				add(r, child, "missing-in-node")
			default:
				walk(r, gv, nv, child)
			}
		}
	case []any:
		nt, ok := n.([]any)
		if !ok {
			add(r, path, "type")
			return
		}
		if len(r.unordered) > 0 && r.unordered[category(path, r.opaqueSet())] {
			// A multiset compare: both sides sorted, then walked by index as usual, so a differing
			// id still reports a value (or length) difference under the same category.
			if gs, ok := sortedNumbers(gt); ok {
				if ns, ok := sortedNumbers(nt); ok {
					gt, nt = gs, ns
				}
			}
		}
		if len(gt) != len(nt) {
			add(r, path, "length")
		}
		for i := 0; i < len(gt) && i < len(nt); i++ {
			walk(r, gt[i], nt[i], append(append([]string(nil), path...), strconv.Itoa(i)))
		}
	case json.Number:
		nt, ok := n.(json.Number)
		if !ok {
			add(r, path, "type")
			return
		}
		if !sameNumber(gt, nt) {
			add(r, path, "value")
		}
	default:
		if fmt.Sprintf("%T", g) != fmt.Sprintf("%T", n) {
			add(r, path, "type")
			return
		}
		if g != n {
			add(r, path, "value")
		}
	}
}

// sortedNumbers returns a copy of a sorted numerically, or false when a holds anything but numbers.
func sortedNumbers(a []any) ([]any, bool) {
	keys := make([]*big.Rat, len(a))
	for i, v := range a {
		n, ok := v.(json.Number)
		if !ok {
			return nil, false
		}
		k, ok := new(big.Rat).SetString(string(n))
		if !ok {
			return nil, false
		}
		keys[i] = k
	}
	idx := make([]int, len(a))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(x, y int) bool { return keys[idx[x]].Cmp(keys[idx[y]]) < 0 })
	out := make([]any, len(a))
	for i, j := range idx {
		out[i] = a[j]
	}
	return out, true
}

// sameNumber compares numerically, so 1 and 1.0 (jsonb vs JS formatting) are equal. Two integer
// literals compare exactly: as float64 every integer above 2^53 has neighbours it cannot tell apart
// (an id or a bigint-sized count would match its off-by-one), and the relative tolerance below would
// also equate large integers that differ by one.
func sameNumber(a, b json.Number) bool {
	if a == b {
		return true
	}
	if isIntegerLiteral(a) && isIntegerLiteral(b) {
		ia, errA := strconv.ParseInt(string(a), 10, 64)
		ib, errB := strconv.ParseInt(string(b), 10, 64)
		if errA == nil && errB == nil {
			return ia == ib
		}
		// Past int64: exactly, as big integers.
		x, okA := new(big.Int).SetString(string(a), 10)
		y, okB := new(big.Int).SetString(string(b), 10)
		return okA && okB && x.Cmp(y) == 0
	}
	fa, errA := a.Float64()
	fb, errB := b.Float64()
	return errA == nil && errB == nil && (fa == fb || math.Abs(fa-fb) < 1e-12*math.Max(math.Abs(fa), math.Abs(fb)))
}

// isIntegerLiteral: a JSON number written without a fraction or an exponent.
func isIntegerLiteral(n json.Number) bool {
	return n != "" && !strings.ContainsAny(string(n), ".eE")
}

// ItemOrder returns the postId sequences of both sides' items, for the "same posts, different order"
// vs "different posts" split the report alone does not make.
func ItemOrder(env []byte) ([]string, error) {
	var e struct {
		JSON struct {
			Items []struct {
				PostID json.Number `json:"postId"`
			} `json:"items"`
		} `json:"json"`
	}
	if err := json.Unmarshal(env, &e); err != nil {
		return nil, err
	}
	out := make([]string, len(e.JSON.Items))
	for i, it := range e.JSON.Items {
		out[i] = it.PostID.String()
	}
	return out, nil
}

// Classify summarises a report into one result label: match, order (same posts, different order),
// membership (different posts), fields (same posts in the same order, field differences).
func Classify(r *Report, goEnv, nodeEnv []byte) string {
	if r.Match {
		return "match"
	}
	g, errG := ItemOrder(goEnv)
	n, errN := ItemOrder(nodeEnv)
	if errG != nil || errN != nil {
		return "fields"
	}
	return classifyOrder(g, n)
}

// classifyOrder splits a non-matching report by its two item key sequences.
func classifyOrder(g, n []string) string {
	if strings.Join(g, ",") == strings.Join(n, ",") {
		return "fields"
	}
	gs, ns := append([]string(nil), g...), append([]string(nil), n...)
	sort.Strings(gs)
	sort.Strings(ns)
	if strings.Join(gs, ",") == strings.Join(ns, ",") {
		return "order"
	}
	return "membership"
}

// flatItemIDs returns the `json.items[].id` sequence of a superjson envelope whose items are keyed by
// their own `id` (a flat page: image.getInfinite's images, model.getAll's models), not posts.
func flatItemIDs(env []byte) ([]string, error) {
	var e struct {
		JSON struct {
			Items []struct {
				ID json.Number `json:"id"`
			} `json:"items"`
		} `json:"json"`
	}
	if err := json.Unmarshal(env, &e); err != nil {
		return nil, err
	}
	out := make([]string, len(e.JSON.Items))
	for i, it := range e.JSON.Items {
		out[i] = it.ID.String()
	}
	return out, nil
}

// ClassifyFlat is Classify for a superjson envelope of a flat page (image.getInfinite's images,
// model.getAll's models): its items are keyed by their own `id`, so match, order (same items,
// different order), membership (different items), fields (same items in the same order, field
// differences). The report itself is Compare's: the same annotation handling, and categories over the
// flat shape (`items.*.<field>`, `items.*.user.<field>`, `nextCursor`, `source`), truncated at the same
// opaque keys.
func ClassifyFlat(r *Report, goEnv, nodeEnv []byte) string {
	if r.Match {
		return "match"
	}
	g, errG := flatItemIDs(goEnv)
	n, errN := flatItemIDs(nodeEnv)
	if errG != nil || errN != nil {
		return "fields"
	}
	return classifyOrder(g, n)
}

// CompareJSON compares two plain-JSON response bodies (Go's, Node's): the public REST endpoints answer
// with `res.json`, so there is no envelope and no annotation — a Date is its ISO string on both sides,
// and an undefined member is absent on both (JSON.stringify drops it). The same structural walk as
// Compare: object key order ignored, array order kept, numbers compared numerically.
func CompareJSON(goBody, nodeBody []byte) (*Report, error) {
	return compareJSON(goBody, nodeBody, nil)
}

// CompareV1Images is CompareJSON for GET /api/v1/images: the same walk, with `items.*.modelVersionIds`
// compared as a multiset of numbers (v1ImagesUnordered).
func CompareV1Images(goBody, nodeBody []byte) (*Report, error) {
	return compareJSON(goBody, nodeBody, v1ImagesUnordered)
}

func compareJSON(goBody, nodeBody []byte, unordered map[string]bool) (*Report, error) {
	gv, err := decode(goBody)
	if err != nil {
		return nil, fmt.Errorf("go body: %w", err)
	}
	nv, err := decode(nodeBody)
	if err != nil {
		return nil, fmt.Errorf("node body: %w", err)
	}
	if _, ok := nv.(map[string]any); !ok {
		return nil, errors.New("node body: not an object")
	}
	r := &Report{opaque: jsonOpaque, unordered: unordered}
	walk(r, gv, nv, nil)
	r.Match = len(r.Diffs) == 0 && !r.Truncated
	return r, nil
}

// itemIDs returns the `items[].id` sequence of a plain-JSON body.
func itemIDs(body []byte) ([]string, error) {
	var b struct {
		Items []struct {
			ID json.Number `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(body, &b); err != nil {
		return nil, err
	}
	out := make([]string, len(b.Items))
	for i, it := range b.Items {
		out[i] = it.ID.String()
	}
	return out, nil
}

// ClassifyJSON is Classify for the plain-JSON REST bodies, whose items are images keyed by `id`:
// match, order (same images, different order), membership (different images), fields.
func ClassifyJSON(r *Report, goBody, nodeBody []byte) string {
	if r.Match {
		return "match"
	}
	g, errG := itemIDs(goBody)
	n, errN := itemIDs(nodeBody)
	if errG != nil || errN != nil {
		return "fields"
	}
	return classifyOrder(g, n)
}
