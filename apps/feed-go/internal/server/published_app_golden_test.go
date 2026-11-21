package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/appchip"
	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/shadow"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// The image-published-app golden fixtures (testdata/golden/image-published-app, written by
// gen-published-app.mjs from the Node code path: README.md "image-published-app"). Each is run
// through the whole computePublishedApp (input, viewer, the marker read over a fake replica holding
// the fixture's image, the encode) and must be served with Node's envelope, byte for byte, and Node's
// devalue body where Node writes one, or fall back with the reason named.

var pubAppGoldenDir = filepath.Join(goldenDir, "image-published-app")

// pubAppGoldenMin is the fixture count: a generator run that wrote fewer fails here.
const pubAppGoldenMin = 37

type pubAppFixture struct {
	Name    string `json:"name"`
	Request struct {
		Input  string `json:"input"`
		Viewer *struct {
			ID          int  `json:"id"`
			IsModerator bool `json:"isModerator"`
		} `json:"viewer"`
		Banned *struct {
			ID int `json:"id"`
		} `json:"banned"`
		Host string `json:"host"`
	} `json:"request"`
	World struct {
		Image *struct {
			ID       int             `json:"id"`
			UserID   int             `json:"userId"`
			Metadata json.RawMessage `json:"metadata"`
		} `json:"image"`
	} `json:"world"`
	Binds *struct {
		ImageID int32 `json:"imageId"`
	} `json:"binds"`
	Expect struct {
		Envelope json.RawMessage `json:"envelope"`
		Status   int             `json:"status"`
	} `json:"expect"`
	Go struct {
		Served      bool   `json:"served"`
		ViewerClass string `json:"viewerClass"`
		Fallback    string `json:"fallback"`
	} `json:"go"`
}

func loadPubAppFixtures(t *testing.T) []*pubAppFixture {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(pubAppGoldenDir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) < pubAppGoldenMin {
		t.Fatalf("%d image-published-app fixtures, want at least %d", len(files), pubAppGoldenMin)
	}
	out := make([]*pubAppFixture, 0, len(files))
	for _, f := range files {
		b, err := os.ReadFile(f) //nolint:gosec // G304: a testdata path
		if err != nil {
			t.Fatal(err)
		}
		var fx pubAppFixture
		if err := json.Unmarshal(b, &fx); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		out = append(out, &fx)
	}
	return out
}

// markerKeyRe is the key the statement reads (`"metadata" -> '<key>'`), so the fake answers the key
// the code asks for, never a constant of its own.
var markerKeyRe = regexp.MustCompile(`"metadata" -> '([^']*)'`)

// markerOf is Postgres's `metadata -> '<key>'` over the fixture's jsonb: the member's JSON (a JSON
// null for a null member), or SQL NULL (nil) when metadata is not an object or has no such member.
func markerOf(t *testing.T, metadata json.RawMessage, key string) any {
	t.Helper()
	var obj map[string]json.RawMessage
	if json.Unmarshal(metadata, &obj) != nil || obj == nil {
		return nil
	}
	v, ok := obj[key]
	if !ok {
		return nil
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, v); err != nil {
		t.Fatal(err)
	}
	return compact.String()
}

// pubAppWorld is the fake replica for a fixture: the marker read answers the fixture's image by its id,
// with the member of its metadata the statement names.
func pubAppWorld(t *testing.T, fx *pubAppFixture) *testkit.DB {
	return &testkit.DB{Routes: []testkit.Route{{
		Match: `FROM "Image" WHERE "id" = $1`,
		SQLRows: func(sql string, args []any) (*testkit.Rows, error) {
			m := markerKeyRe.FindStringSubmatch(sql)
			if m == nil {
				return nil, fmt.Errorf("the image read names no metadata member: %s", sql)
			}
			rows := testkit.NewRows([]string{"userId", "marker"})
			if img := fx.World.Image; img != nil && len(args) == 1 && args[0] == int32(img.ID) { //nolint:gosec // G115: fixture ids are int4
				rows = testkit.NewRows([]string{"userId", "marker"}, []any{img.UserID, markerOf(t, img.Metadata, m[1])})
			}
			return rows, nil
		},
	}}}
}

func pubAppCompute(ctx context.Context, t *testing.T, fx *pubAppFixture) (*computed, *testkit.DB, error) {
	t.Helper()
	db := pubAppWorld(t, fx)
	s := &Server{PublishedApp: &appchip.Deps{DB: db}}
	var user *auth.SessionUser
	switch {
	case fx.Request.Banned != nil:
		user = &auth.SessionUser{ID: fx.Request.Banned.ID, Banned: true}
	case fx.Request.Viewer != nil:
		user = &auth.SessionUser{ID: fx.Request.Viewer.ID, IsModerator: fx.Request.Viewer.IsModerator}
	}
	r, err := SyntheticPublishedAppRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: map[string]string{"host": fx.Request.Host}})
	if err != nil {
		t.Fatal(err)
	}
	c, err := s.computePublishedApp(auth.WithResolved(ctx, user, nil), r)
	return c, db, err
}

// pubAppMatch reports why Go's envelope is not Node's ("" = it is, byte for byte).
func pubAppMatch(goEnv, nodeEnv []byte) string {
	var compact bytes.Buffer
	if err := json.Compact(&compact, nodeEnv); err != nil {
		return "node envelope: " + err.Error()
	}
	r, err := shadow.Compare(goEnv, compact.Bytes())
	if err != nil {
		return err.Error()
	}
	if !r.Match {
		return "differs: " + string(goEnv) + " vs " + compact.String()
	}
	if !bytes.Equal(goEnv, compact.Bytes()) {
		return "same value, other bytes: " + string(goEnv) + " vs " + compact.String()
	}
	return ""
}

func TestPublishedAppGolden(t *testing.T) {
	served, fellBack := 0, 0
	for _, fx := range loadPubAppFixtures(t) {
		t.Run(fx.Name, func(t *testing.T) {
			c, db, err := pubAppCompute(context.Background(), t, fx)
			// The read: bound with Node's image id, exactly when feed-go reaches it (served, or a marked
			// image); never for an id isPgInt4 refuses.
			wantReads := 0
			if fx.Binds != nil && (fx.Go.Served || fx.Go.Fallback == "published-app-marked") {
				wantReads = 1
			}
			if len(db.Calls) != wantReads {
				t.Fatalf("%d reads, want %d", len(db.Calls), wantReads)
			}
			if fx.Go.Fallback != "" {
				if got := fallback.Reason(err); got != fx.Go.Fallback {
					t.Fatalf("fallback %q (%v), want %q", got, err, fx.Go.Fallback)
				}
				fellBack++
				return
			}
			if !fx.Go.Served || fx.Expect.Status != 0 {
				t.Fatalf("a fixture feed-go serves must carry Node's 200 envelope: %+v", fx.Go)
			}
			if err != nil {
				t.Fatalf("compute: %v", err)
			}
			defer c.release()
			if why := pubAppMatch(c.payload, fx.Expect.Envelope); why != "" {
				t.Fatal(why)
			}
			if c.viewerClass != fx.Go.ViewerClass {
				t.Fatalf("viewer class %q, want %q", c.viewerClass, fx.Go.ViewerClass)
			}
			if signedOut := fx.Request.Viewer == nil; signedOut != (c.ttl != nil && *c.ttl == trpc.SignedOutTTL) {
				t.Fatalf("ttl %v for signed out = %v", c.ttl, signedOut)
			}
			served++
		})
	}
	if served == 0 || fellBack == 0 {
		t.Fatalf("served %d, fell back %d: the fixtures must cover both", served, fellBack)
	}
}

// Node's devalue body for every served fixture (devalue-body.mjs): feed-go's body, written through
// computed.encode for a request marked for devalue, equals it where the answer is not edge-cacheable (a
// session), and is superjson where it is (signed out), as the app writes it.
func TestPublishedAppGoldenDevalue(t *testing.T) {
	checked := 0
	for _, fx := range loadPubAppFixtures(t) {
		if !fx.Go.Served {
			continue
		}
		t.Run(fx.Name, func(t *testing.T) {
			node, err := os.ReadFile(filepath.Join(goldenDevalueDir, "image-published-app", fx.Name+".txt")) //nolint:gosec // G304: a testdata path
			if err != nil {
				t.Fatalf("no devalue body for a served fixture (regenerate): %v", err)
			}
			c, _, err := pubAppCompute(trpc.WithDevalueWrite(context.Background()), t, fx)
			if err != nil {
				t.Fatal(err)
			}
			defer c.release()
			if fx.Request.Viewer == nil {
				if c.devalue {
					t.Fatalf("a signed-out (edge-cacheable) answer was written as devalue: %s", c.payload)
				}
				return
			}
			body := `{"result":{"data":` + string(c.payload) + `}}`
			if !c.devalue || body != string(node) {
				t.Fatalf("devalue=%v body %s, want %s", c.devalue, body, node)
			}
			checked++
		})
	}
	if checked == 0 {
		t.Fatal("no session fixture's devalue body was compared")
	}
}

// The harness can fail: a served fixture whose Node answer is changed to a chip no longer matches,
// a marker added to an unmarked image turns a served fixture into the marked fallback, and the byte
// check sees a re-ordered but equal envelope.
func TestPublishedAppGoldenHarnessCanFail(t *testing.T) {
	var fx *pubAppFixture
	for _, f := range loadPubAppFixtures(t) {
		if f.Name == "signed-in-scope-full-plain" {
			fx = f
		}
	}
	if fx == nil {
		t.Fatal("the control fixture is missing")
	}
	c, _, err := pubAppCompute(context.Background(), t, fx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.release()
	if why := pubAppMatch(c.payload, []byte(`{"json":{"slug":"sketchpad","name":"Sketchpad","iconUrl":null}}`)); why == "" {
		t.Fatal("a chip matched feed-go's null")
	}
	if why := pubAppMatch([]byte(`{"json":{"b":1,"a":2}}`), []byte(`{"json":{"a":2,"b":1}}`)); !strings.HasPrefix(why, "same value, other bytes") {
		t.Fatalf("byte check: %q", why)
	}
	marked := *fx
	img := *fx.World.Image
	img.Metadata = json.RawMessage(`{"blockPublishedAppId":"appblk-sketchpad"}`)
	marked.World.Image = &img
	if _, _, err := pubAppCompute(context.Background(), t, &marked); fallback.Reason(err) != "published-app-marked" {
		t.Fatalf("a marked image: %v, want the marked fallback", err)
	}
}
