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
// devalue BYTES differ there, and only there: TestGoldenDevalue* encodes feed-go's value with Node's
// key order at the places where only the order differs and then requires Node's exact bytes
// (goldenDevalueMatch), and requires those places to be exactly this list (a fix that removes one, or
// a change that adds one, fails until the list says so).
var goldenDevalueKeyOrder = map[string][]string{
	"as-posts": {
		"items.N.images.N.cosmetic.data",                // the frame's cosmetic record
		"items.N.images.N.eventDecoration.data",         // the event decoration's cosmetic record
		"items.N.images.N.user.profilePicture.metadata", // the profile-pictures cache record
		"items.N.user.profilePicture.metadata",          // the same record, on the post's user
	},
	"infinite": {
		"items.N.cosmetic.data",
		"items.N.user.profilePicture.metadata",
	},
	"model-getall": {
		"items.N.images.N",                     // the showcase image cache record (modelfeed imageWire)
		"items.N.images.N.metadata",            // and its metadata
		"items.N.user.profilePicture.metadata", // the profile-pictures cache record
		"items.N.version",                      // the version cache record (modelfeed versionWire)
	},
}

type goldenDevalueCompute func(ctx context.Context, t *testing.T, fx *goldenFixture) (*computed, error)

func goldenDevalueAsPosts(ctx context.Context, t *testing.T, fx *goldenFixture) (*computed, error) {
	env := goldenSetupMode(t, fx, false)
	r, err := SyntheticRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	return env.server.compute(ctx, r)
}

func goldenDevalueInfinite(ctx context.Context, t *testing.T, fx *goldenFixture) (*computed, error) {
	env := goldenSetupMode(t, fx, false)
	r, err := SyntheticInfiniteRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	return env.server.computeInfinite(ctx, r)
}

func goldenDevalueModels(ctx context.Context, t *testing.T, fx *goldenFixture) (*computed, error) {
	env := goldenSetupModelsMode(t, fx, false)
	r, err := SyntheticModelGetAllRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	return env.server.computeModelGetAll(ctx, r)
}

func TestGoldenDevalueAsPosts(t *testing.T) {
	goldenDevalueRun(t, "as-posts", goldenMinAsPosts, 30, goldenDevalueAsPosts)
}

func TestGoldenDevalueInfinite(t *testing.T) {
	goldenDevalueRun(t, "infinite", goldenMinInfinite, 69, goldenDevalueInfinite)
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
	served, exact := 0, 0
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
			served++
			if `{"result":{"data":`+string(payload)+`}}` == string(node) {
				exact++
			}
			paths, err := goldenDevalueMatch(c.value, string(node))
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
	t.Logf("%s: %d of %d served fixtures byte-identical to Node's devalue body; the others differ only in goldenDevalueKeyOrder", dir, exact, served)
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

// goldenDevalueMatch takes feed-go's answer value, puts each object's keys in the order Node's has
// them wherever the two hold the same keys in another order (recording those normalized paths), and
// requires feed-go's devalue body for that value to be Node's body, byte for byte. Only key order is
// taken from Node: the values, which objects are shared (feed-go's references, kept by copying each
// object once), the undefined members and every byte of the writer are feed-go's own, and Node's bytes
// are the only oracle (nothing of Node's side is re-encoded here).
func goldenDevalueMatch(goValue any, nodeBody string) ([]string, error) {
	nodeV, err := goldenDevalueValue(nodeBody)
	if err != nil {
		return nil, fmt.Errorf("Node body: %w", err)
	}
	r := &goldenReorder{paths: map[string]bool{}, memo: map[[2]uintptr]any{}, raws: map[[2]uintptr]any{}}
	v, err := r.walk("", goValue, nodeV)
	if err != nil {
		return nil, err
	}
	payload, err := devalue.Payload(v)
	if err != nil {
		return nil, err
	}
	if body := `{"result":{"data":` + string(payload) + `}}`; body != nodeBody {
		at := 0
		for at < len(body) && at < len(nodeBody) && body[at] == nodeBody[at] {
			at++
		}
		from := max(at-300, 0)
		return nil, fmt.Errorf("with Node's key order the bodies still differ at byte %d:\n feed-go …%s\n Node    …%s",
			at, body[from:min(at+300, len(body))], nodeBody[from:min(at+300, len(nodeBody))])
	}
	out := make([]string, 0, len(r.paths))
	for p := range r.paths {
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

// goldenReorder copies feed-go's value with Node's key order (see goldenDevalueMatch). memo maps each
// feed-go object or array (backing array and length) to its one copy, so a shared reference stays
// shared and a distinct one distinct; raws holds each json.RawMessage buffer parsed once, as the writer
// reads it.
type goldenReorder struct {
	paths map[string]bool
	memo  map[[2]uintptr]any
	raws  map[[2]uintptr]any
}

func goldenSliceKey(v any) [2]uintptr {
	rv := reflect.ValueOf(v)
	return [2]uintptr{rv.Pointer(), uintptr(rv.Len())}
}

func (r *goldenReorder) walk(path string, g, n any) (any, error) {
	switch x := g.(type) {
	case *superjson.Object:
		if x == nil {
			return g, nil
		}
		return r.walk(path, *x, n)
	case json.RawMessage:
		if len(x) == 0 {
			return g, nil
		}
		k := goldenSliceKey(x)
		parsed, ok := r.raws[k]
		if !ok {
			var err error
			if parsed, err = devalue.ParseJSON(x); err != nil {
				return nil, fmt.Errorf("%s: %w", path, err)
			}
			r.raws[k] = parsed
		}
		return r.walk(path, parsed, n)
	case superjson.Object:
		if len(x) == 0 {
			return g, nil
		}
		k := goldenSliceKey(x)
		if c, ok := r.memo[k]; ok {
			return c, nil
		}
		y, ok := n.(superjson.Object)
		if !ok {
			return nil, fmt.Errorf("%s: feed-go has an object, Node %T", path, n)
		}
		gk, nk := make([]string, len(x)), make([]string, len(y))
		for i, f := range x {
			gk[i] = f.Key
		}
		for i, f := range y {
			nk[i] = f.Key
		}
		order := gk
		if strings.Join(gk, "\x00") != strings.Join(nk, "\x00") {
			sg, sn := append([]string(nil), gk...), append([]string(nil), nk...)
			sort.Strings(sg)
			sort.Strings(sn)
			if strings.Join(sg, "\x00") != strings.Join(sn, "\x00") {
				return nil, fmt.Errorf("%s: feed-go keys %v, Node keys %v", path, gk, nk)
			}
			r.paths[strings.TrimPrefix(goldenIndexSegment.ReplaceAllString(path, ".N"), ".")] = true
			order = nk
		}
		out := make(superjson.Object, 0, len(x))
		r.memo[k] = out
		for _, key := range order {
			gv, _ := x.Get(key)
			nv, _ := y.Get(key)
			cv, err := r.walk(path+"."+key, gv, nv)
			if err != nil {
				return nil, err
			}
			out = append(out, superjson.Field{Key: key, Val: cv})
		}
		// The backing array was sized above, so the memoized header and this one share it; record the
		// full one.
		r.memo[k] = out
		return out, nil
	case []any:
		if len(x) == 0 {
			return g, nil
		}
		k := goldenSliceKey(x)
		if c, ok := r.memo[k]; ok {
			return c, nil
		}
		y, ok := n.([]any)
		if !ok || len(y) != len(x) {
			return nil, fmt.Errorf("%s: feed-go has %d items, Node %T", path, len(x), n)
		}
		out := make([]any, len(x))
		r.memo[k] = out
		for i := range x {
			cv, err := r.walk(fmt.Sprintf("%s.%d", path, i), x[i], y[i])
			if err != nil {
				return nil, err
			}
			out[i] = cv
		}
		return out, nil
	}
	return g, nil
}

// The match can fail: a changed leaf, a reference Node shares and feed-go does not, a missing key and
// an extra undefined member are each reported, and only a key-order difference is taken from Node.
func TestGoldenDevalueMatchCanFail(t *testing.T) {
	shared := superjson.Object{{Key: "id", Val: 1}, {Key: "n", Val: "a"}}
	p, err := devalue.Payload([]any{shared, shared})
	if err != nil {
		t.Fatal(err)
	}
	node := `{"result":{"data":` + string(p) + `}}`
	if paths, err := goldenDevalueMatch([]any{shared, shared}, node); err != nil || len(paths) != 0 {
		t.Fatalf("identical: %v %v", paths, err)
	}
	for name, goV := range map[string]any{
		"leaf":          []any{superjson.Object{{Key: "id", Val: 2}, {Key: "n", Val: "a"}}, superjson.Object{{Key: "id", Val: 2}, {Key: "n", Val: "a"}}},
		"not shared":    []any{superjson.Object{{Key: "id", Val: 1}, {Key: "n", Val: "a"}}, superjson.Object{{Key: "id", Val: 1}, {Key: "n", Val: "a"}}},
		"missing key":   []any{superjson.Object{{Key: "id", Val: 1}}, superjson.Object{{Key: "id", Val: 1}}},
		"undefined key": []any{superjson.Object{{Key: "id", Val: 1}, {Key: "n", Val: "a"}, {Key: "u", Val: superjson.Undefined{}}}, shared},
		"date":          []any{superjson.Object{{Key: "id", Val: time.Unix(1, 0)}, {Key: "n", Val: "a"}}, shared},
	} {
		if _, err := goldenDevalueMatch(goV, node); err == nil {
			t.Errorf("%s: no difference reported", name)
		}
	}
	reordered := superjson.Object{{Key: "n", Val: "a"}, {Key: "id", Val: 1}}
	paths, err := goldenDevalueMatch([]any{reordered, reordered}, node)
	if err != nil || len(paths) != 1 || paths[0] != "N" {
		t.Fatalf("key order: paths %v, err %v; want [N]", paths, err)
	}
	if _, err := goldenDevalueMatch(shared, `{"result":{"data":{"json":1}}}`); err == nil {
		t.Fatal("a superjson body read as devalue")
	}
}
