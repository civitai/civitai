// Package shadow compares this service's answer with the Node app's for the same request.
//
// Both sides are superjson envelopes `{json, meta}`. The comparison is on DECODED values, which is what
// the client renders: `json` trees compared structurally (object key order ignored, array order kept)
// after the ["undefined"] annotations are applied as superjson.deserialize applies them (Node writes
// an undefined member as `null` + annotation, this service omits it; both decode to undefined), and the
// `meta.values` annotation sets compared as sets (a Date annotated on one side only is a type
// difference the client would see). `meta.referentialEqualities` is ignored: it changes object identity
// after decode, never a value.
package shadow

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
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
}

// MaxDiffs bounds the differences collected per comparison.
const MaxDiffs = 64

// opaque keys: their subtrees are free-form JSON (image metadata, cosmetic data), so a category stops
// there and metric label cardinality stays bounded by the response schema.
var opaque = map[string]bool{"metadata": true, "data": true, "remixOfId": true}

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
// undefined object member as `null` plus the annotation; this service's writer omits the member and
// writes the same annotation. Both decode to the same object, so the raw json alone must not be
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
	r.Diffs = append(r.Diffs, Diff{Path: strings.Join(path, "."), Category: Category(path), Kind: kind})
}

// Category folds array indices to `*` and truncates at the first opaque key.
func Category(path []string) string {
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

// sameNumber compares numerically, so 1 and 1.0 (jsonb vs JS formatting) are equal.
func sameNumber(a, b json.Number) bool {
	if a == b {
		return true
	}
	fa, errA := a.Float64()
	fb, errB := b.Float64()
	return errA == nil && errB == nil && (fa == fb || math.Abs(fa-fb) < 1e-12*math.Max(math.Abs(fa), math.Abs(fb)))
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
