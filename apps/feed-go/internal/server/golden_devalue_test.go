package server

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/devalue"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// Node's devalue bodies: testdata/golden/devalue/<dir>/<fixture>.txt, the exact bytes the Node app
// writes for each served fixture's answer with TRPC_WRITE_DEVALUE=true (devalue-body.mjs, run by
// gen.mjs and gen-models.mjs on the same value they encode as the superjson envelope).
var goldenDevalueDir = filepath.Join(goldenDir, "devalue")

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
//   - a signed-in answer is devalue, and its body is Node's devalue body, byte for byte: every object's
//     keys in Node's order, a cached record's nested objects included (hydrate.Entry.Ordered);
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
		served++
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
			if body := `{"result":{"data":` + string(payload) + `}}`; body != string(node) {
				t.Fatal(goldenFirstDifference(body, string(node)))
			}
			exact++
		})
	}
	for name := range unclaimed {
		t.Errorf("%s: a Node devalue body without a served fixture", name)
	}
	t.Logf("%s: %d of %d served fixtures byte-identical to Node's devalue body", dir, exact, served)
	if exact != served {
		t.Errorf("%s: %d of %d served fixtures differ from Node's devalue body", dir, served-exact, served)
	}
}

// goldenFirstDifference reports where feed-go's devalue body first differs from Node's, with the bytes
// around it from each.
func goldenFirstDifference(body, node string) string {
	at := 0
	for at < len(body) && at < len(node) && body[at] == node[at] {
		at++
	}
	from := max(at-300, 0)
	return fmt.Sprintf("the devalue body differs from Node's at byte %d (lengths %d and %d):\n feed-go …%s\n Node    …%s",
		at, len(body), len(node), body[from:min(at+300, len(body))], node[from:min(at+300, len(node))])
}

// The comparison can fail: a body that differs from Node's only in one object's key order is reported,
// at the first differing byte.
func TestGoldenFirstDifference(t *testing.T) {
	a, err := devalue.Payload(superjson.Object{{Key: "id", Val: int64(1)}, {Key: "n", Val: "a"}})
	if err != nil {
		t.Fatal(err)
	}
	b, err := devalue.Payload(superjson.Object{{Key: "n", Val: "a"}, {Key: "id", Val: int64(1)}})
	if err != nil {
		t.Fatal(err)
	}
	if string(a) == string(b) {
		t.Fatal("two key orders wrote the same devalue bytes")
	}
	msg := goldenFirstDifference(string(a), string(b))
	if !strings.Contains(msg, "differs from Node's at byte") {
		t.Fatalf("message %q", msg)
	}
}
