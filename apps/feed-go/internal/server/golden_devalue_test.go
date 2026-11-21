package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/devalue"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// Node's devalue bodies: testdata/golden/devalue/<dir>/<fixture>.txt, the exact bytes the Node app
// writes for each served fixture's answer with TRPC_WRITE_DEVALUE=true (devalue-body.mjs, run by
// gen.mjs and gen-models.mjs on the same value they encode as the superjson envelope).
var goldenDevalueDir = filepath.Join(goldenDir, "devalue")

// goldenDevalueKeyOrder is every place where feed-go's answer holds an object's keys in another order
// than Node's, per directory, as a normalized path (array indexes as N). These are cache records and
// their nested json columns: the hydrate layer decodes a cached msgpack map into a Go map and
// hydrate.Wire writes its keys sorted, while the Node object keeps the order it was written in. The
// value is the same (the client reads keys, not their order), so the superjson comparison passes; the
// devalue BYTES differ there, and only there: TestGoldenDevalue* puts both answers' keys in one order
// and then requires the same bytes, and requires the places that needed it to be exactly this list
// (a fix that removes one, or a change that adds one, fails until the list says so).
var goldenDevalueKeyOrder = map[string][]string{
	"as-posts":     {},
	"infinite":     {},
	"model-getall": {},
}

type goldenDevalueCompute func(ctx context.Context, t *testing.T, fx *goldenFixture) (*computed, error)

func goldenDevalueAsPosts(ctx context.Context, t *testing.T, fx *goldenFixture) (*computed, error) {
	env := goldenSetupMode(t, fx, false)
	r, err := SyntheticRequest(context.Background(), ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	return env.server.compute(ctx, r)
}

func goldenDevalueInfinite(ctx context.Context, t *testing.T, fx *goldenFixture) (*computed, error) {
	env := goldenSetupMode(t, fx, false)
	r, err := SyntheticInfiniteRequest(context.Background(), ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	return env.server.computeInfinite(ctx, r)
}

func goldenDevalueModels(ctx context.Context, t *testing.T, fx *goldenFixture) (*computed, error) {
	env := goldenSetupModelsMode(t, fx, false)
	r, err := SyntheticModelGetAllRequest(context.Background(), ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	return env.server.computeModelGetAll(ctx, r)
}

func TestGoldenDevalueAsPosts(t *testing.T) {
	goldenDevalueRun(t, "as-posts", goldenMinAsPosts, 30, goldenDevalueAsPosts)
}

func TestGoldenDevalueInfinite(t *testing.T) {
	goldenDevalueRun(t, "infinite", goldenMinInfinite, 47, goldenDevalueInfinite)
}

func TestGoldenDevalueModelGetAll(t *testing.T) {
	goldenDevalueRun(t, "model-getall", goldenMinModels, 27, goldenDevalueModels)
}

// goldenDevalueRun computes every served fixture of dir as a capable web client on a pool with
// TRPC_WRITE_DEVALUE on (the request marked, trpc.WithDevalueWrite) and requires:
//   - a signed-in answer is devalue, and its body is Node's devalue body (see goldenDevalueKeyOrder);
//   - an edge-cacheable (signed-out) answer is superjson, byte for byte the unmarked encoding, and the
//     devalue writer still writes Node's bytes for its value;
//   - every served fixture has a Node body and every Node body a served fixture.
func goldenDevalueRun(t *testing.T, dir string, minFixtures, minBodies int, compute goldenDevalueCompute) {
	bodies, err := filepath.Glob(filepath.Join(goldenDevalueDir, dir, "*.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if len(bodies) < minBodies {
		t.Fatalf("%s: %d Node devalue bodies, want at least %d (did the glob match nothing?)", dir, len(bodies), minBodies)
	}
	unclaimed := map[string]bool{}
	for _, b := range bodies {
		unclaimed[strings.TrimSuffix(filepath.Base(b), ".txt")] = true
	}
	observed := map[string]bool{}
	for _, path := range goldenFiles(t, dir, minFixtures) {
		fx := goldenLoad(t, path)
		if fx.Expect.Fallback != "" {
			if unclaimed[fx.Name] {
				t.Errorf("%s: a Node devalue body for a fallback fixture", fx.Name)
			}
			continue
		}
		delete(unclaimed, fx.Name)
		t.Run(fx.Name, func(t *testing.T) {
			node, err := os.ReadFile(filepath.Join(goldenDevalueDir, dir, fx.Name+".txt")) //nolint:gosec // G304: a testdata path
			if err != nil {
				t.Fatalf("no Node devalue body: %v (run gen.mjs / gen-models.mjs)", err)
			}
			c, err := compute(trpc.WithDevalueWrite(context.Background()), t, fx)
			if err != nil {
				t.Fatalf("compute: %v", err)
			}
			defer c.release()
			payload, err := devalue.Payload(c.value)
			if err != nil {
				t.Fatalf("devalue: %v", err)
			}
			if c.ttl == nil {
				if !c.devalue || !bytes.Equal(c.payload, payload) {
					t.Fatalf("a private answer to a marked request: devalue=%v, payload %.120s", c.devalue, c.payload)
				}
			} else {
				sj, err := superjson.Serialize(c.value)
				if err != nil {
					t.Fatal(err)
				}
				if c.devalue || !bytes.Equal(c.payload, sj) {
					t.Fatalf("an edge-cacheable answer must stay superjson: devalue=%v, payload %.120s", c.devalue, c.payload)
				}
			}
			body := `{"result":{"data":` + string(payload) + `}}`
			paths, err := goldenDevalueCompare(body, string(node))
			if err != nil {
				t.Fatal(err)
			}
			for _, p := range paths {
				observed[p] = true
				if !goldenListed(goldenDevalueKeyOrder[dir], p) {
					t.Errorf("key order differs from Node at %s (not in goldenDevalueKeyOrder[%q])", p, dir)
				}
			}
		})
	}
	for name := range unclaimed {
		t.Errorf("%s: a Node devalue body without a served fixture", name)
	}
	if t.Failed() {
		return
	}
	for _, p := range goldenDevalueKeyOrder[dir] {
		if !observed[p] {
			t.Errorf("goldenDevalueKeyOrder[%q] lists %s, where no fixture differs any more: remove it", dir, p)
		}
	}
}

func goldenListed(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// goldenDevalueCompare returns nil when goBody is nodeBody. Otherwise it reads both (devalue.Parse) and
// returns the normalized paths of the objects whose keys are the same but in another order, after
// requiring that with every object's keys in one order the two answers are the same bytes: the same
// values, the same shared references, the same undefined members.
func goldenDevalueCompare(goBody, nodeBody string) ([]string, error) {
	if goBody == nodeBody {
		return nil, nil
	}
	goV, err := goldenDevalueValue(goBody)
	if err != nil {
		return nil, fmt.Errorf("feed-go body: %w", err)
	}
	nodeV, err := goldenDevalueValue(nodeBody)
	if err != nil {
		return nil, fmt.Errorf("Node body: %w", err)
	}
	w := &goldenOrderWalk{paths: map[string]bool{}, seen: map[[2]uintptr]bool{}}
	if err := w.walk("", goV, nodeV); err != nil {
		return nil, err
	}
	goText, err := devalue.Stringify(goldenSortKeys(goV, map[uintptr]any{}))
	if err != nil {
		return nil, err
	}
	nodeText, err := devalue.Stringify(goldenSortKeys(nodeV, map[uintptr]any{}))
	if err != nil {
		return nil, err
	}
	if goText != nodeText {
		at := 0
		for at < len(goText) && at < len(nodeText) && goText[at] == nodeText[at] {
			at++
		}
		from := max(at-300, 0)
		return nil, fmt.Errorf("with keys in one order the answers still differ at byte %d:\n feed-go …%s\n Node    …%s",
			at, goText[from:min(at+300, len(goText))], nodeText[from:min(at+300, len(nodeText))])
	}
	out := make([]string, 0, len(w.paths))
	for p := range w.paths {
		out = append(out, p)
	}
	sort.Strings(out)
	return out, nil
}

func goldenDevalueValue(body string) (any, error) {
	var env struct {
		Result struct {
			Data json.RawMessage `json:"data"`
		} `json:"result"`
	}
	if err := json.Unmarshal([]byte(body), &env); err != nil {
		return nil, err
	}
	var text string
	if err := json.Unmarshal(env.Result.Data, &text); err != nil {
		return nil, fmt.Errorf("data is not a devalue string: %w", err)
	}
	return devalue.Parse(text)
}

var goldenIndexSegment = regexp.MustCompile(`\.\d+`)

// goldenOrderWalk walks two parsed answers together, recording where an object's keys are the same set
// in another order, and failing where the shapes differ (a missing key, another type).
type goldenOrderWalk struct {
	paths map[string]bool
	seen  map[[2]uintptr]bool
}

func goldenRef(v any) uintptr {
	switch v.(type) {
	case superjson.Object, []any, *time.Time:
		return reflect.ValueOf(v).Pointer()
	}
	return 0
}

func (w *goldenOrderWalk) walk(path string, a, b any) error {
	if ra, rb := goldenRef(a), goldenRef(b); ra != 0 && rb != 0 {
		if w.seen[[2]uintptr{ra, rb}] {
			return nil
		}
		w.seen[[2]uintptr{ra, rb}] = true
	}
	switch x := a.(type) {
	case superjson.Object:
		y, ok := b.(superjson.Object)
		if !ok {
			return fmt.Errorf("%s: feed-go has an object, Node %T", path, b)
		}
		ka, kb := make([]string, len(x)), make([]string, len(y))
		for i, f := range x {
			ka[i] = f.Key
		}
		for i, f := range y {
			kb[i] = f.Key
		}
		if strings.Join(ka, "\x00") != strings.Join(kb, "\x00") {
			sa, sb := append([]string(nil), ka...), append([]string(nil), kb...)
			sort.Strings(sa)
			sort.Strings(sb)
			if strings.Join(sa, "\x00") != strings.Join(sb, "\x00") {
				return fmt.Errorf("%s: feed-go keys %v, Node keys %v", path, ka, kb)
			}
			w.paths[strings.TrimPrefix(goldenIndexSegment.ReplaceAllString(path, ".N"), ".")] = true
		}
		for _, f := range x {
			v, _ := y.Get(f.Key)
			if err := w.walk(path+"."+f.Key, f.Val, v); err != nil {
				return err
			}
		}
	case []any:
		y, ok := b.([]any)
		if !ok || len(y) != len(x) {
			return fmt.Errorf("%s: feed-go has %d items, Node %#v", path, len(x), b)
		}
		for i := range x {
			if err := w.walk(fmt.Sprintf("%s.%d", path, i), x[i], y[i]); err != nil {
				return err
			}
		}
	}
	return nil
}

// goldenSortKeys copies v with every object's keys sorted, one copy per original object, so shared
// references stay shared.
func goldenSortKeys(v any, memo map[uintptr]any) any {
	switch x := v.(type) {
	case superjson.Object:
		p := reflect.ValueOf(x).Pointer()
		if c, ok := memo[p]; ok {
			return c
		}
		out := make(superjson.Object, len(x), max(len(x), 1))
		memo[p] = out
		copy(out, x)
		sort.SliceStable(out, func(i, j int) bool { return out[i].Key < out[j].Key })
		for i := range out {
			out[i].Val = goldenSortKeys(out[i].Val, memo)
		}
		return out
	case []any:
		p := reflect.ValueOf(x).Pointer()
		if c, ok := memo[p]; ok {
			return c
		}
		out := make([]any, len(x), max(len(x), 1))
		memo[p] = out
		for i := range x {
			out[i] = goldenSortKeys(x[i], memo)
		}
		return out
	}
	return v
}

// The comparison can fail: a changed leaf, a reference Node shares and feed-go does not, a missing
// key and a key-order difference are each reported, and identical bodies are no difference.
func TestGoldenDevalueCompareCanFail(t *testing.T) {
	body := func(v any) string {
		p, err := devalue.Payload(v)
		if err != nil {
			t.Fatal(err)
		}
		return `{"result":{"data":` + string(p) + `}}`
	}
	shared := superjson.Object{{Key: "id", Val: 1}, {Key: "n", Val: "a"}}
	node := body([]any{shared, shared})
	if paths, err := goldenDevalueCompare(node, node); err != nil || paths != nil {
		t.Fatalf("identical: %v %v", paths, err)
	}
	for name, goV := range map[string]any{
		"leaf":          []any{superjson.Object{{Key: "id", Val: 2}, {Key: "n", Val: "a"}}, superjson.Object{{Key: "id", Val: 2}, {Key: "n", Val: "a"}}},
		"not shared":    []any{superjson.Object{{Key: "id", Val: 1}, {Key: "n", Val: "a"}}, superjson.Object{{Key: "id", Val: 1}, {Key: "n", Val: "a"}}},
		"missing key":   []any{superjson.Object{{Key: "id", Val: 1}}, superjson.Object{{Key: "id", Val: 1}}},
		"undefined key": []any{superjson.Object{{Key: "id", Val: 1}, {Key: "n", Val: "a"}, {Key: "u", Val: superjson.Undefined{}}}, shared},
	} {
		if _, err := goldenDevalueCompare(body(goV), node); err == nil {
			t.Errorf("%s: no difference reported", name)
		}
	}
	reordered := superjson.Object{{Key: "n", Val: "a"}, {Key: "id", Val: 1}}
	paths, err := goldenDevalueCompare(body([]any{reordered, reordered}), node)
	if err != nil || len(paths) != 1 || paths[0] != "N" {
		t.Fatalf("key order: paths %v, err %v; want [N]", paths, err)
	}
	if _, err := goldenDevalueCompare(`{"result":{"data":{"json":1}}}`, node); err == nil {
		t.Fatal("a superjson body read as devalue")
	}
}
