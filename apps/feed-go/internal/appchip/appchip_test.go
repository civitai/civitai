package appchip

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/testkit"
)

func num(s string) json.Number { return json.Number(s) }

// Parse is getByIdSchema: `id` a JS number; the client's transport keys pass; any other key, and
// every value z.number() refuses, falls back.
func TestParse(t *testing.T) {
	for _, c := range []struct {
		name   string
		in     map[string]any
		id     float64
		reason string
	}{
		{"an integer", map[string]any{"id": num("8101")}, 8101, ""},
		{"an exponent literal", map[string]any{"id": num("8.101e3")}, 8101, ""},
		{"a fraction", map[string]any{"id": num("8101.5")}, 8101.5, ""},
		{"negative", map[string]any{"id": num("-3")}, -3, ""},
		{"past int4", map[string]any{"id": num("2147483648")}, 2147483648, ""},
		{"with the transport keys", map[string]any{"id": num("7"), "authed": true, "direction": "forward"}, 7, ""},
		{"missing", map[string]any{}, 0, "input-invalid"},
		{"null", map[string]any{"id": nil}, 0, "input-invalid"},
		{"a string (a superjson bigint arrives as one)", map[string]any{"id": "8101"}, 0, "input-invalid"},
		{"a boolean", map[string]any{"id": true}, 0, "input-invalid"},
		{"past the double range", map[string]any{"id": num("1e400")}, 0, "input-invalid"},
		{"an unknown key", map[string]any{"id": num("7"), "postId": num("1")}, 0, "input-unknown-key"},
	} {
		in, err := Parse(c.in)
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: reason %q (%v), want %q", c.name, got, err, c.reason)
			continue
		}
		if c.reason == "" && in.ID != c.id {
			t.Errorf("%s: id %v, want %v", c.name, in.ID, c.id)
		}
	}
}

// Int4 is isPgInt4: an integer within int4, both bounds inclusive.
func TestInt4(t *testing.T) {
	for _, c := range []struct {
		id   float64
		want int32
		ok   bool
	}{
		{8101, 8101, true},
		{0, 0, true},
		{math.Copysign(0, -1), 0, true},
		{-3, -3, true},
		{math.MaxInt32, math.MaxInt32, true},
		{math.MinInt32, math.MinInt32, true},
		{math.MaxInt32 + 1, 0, false},
		{math.MinInt32 - 1, 0, false},
		{8101.5, 0, false},
		{-0.5, 0, false},
		{1e300, 0, false},
	} {
		got, ok := (&Input{ID: c.id}).Int4()
		if ok != c.ok || got != c.want {
			t.Errorf("Int4(%v) = %d, %v; want %d, %v", c.id, got, ok, c.want, c.ok)
		}
	}
}

// Marked is readAppIdMarker's "is there a marker" for the value `metadata -> 'blockPublishedAppId'`
// yields: a non-empty JSON string. The non-strings and the empty string are no marker (Node: null);
// a whitespace-only string counts, so it falls back rather than decide JS's trim.
func TestMarked(t *testing.T) {
	for _, c := range []struct {
		raw  []byte
		want bool
	}{
		{nil, false},
		{[]byte(`null`), false},
		{[]byte(`""`), false},
		{[]byte(`42`), false},
		{[]byte(`true`), false},
		{[]byte(`{"id":"appblk-x"}`), false},
		{[]byte(`["appblk-x"]`), false},
		{[]byte(`"appblk-sketchpad"`), true},
		{[]byte(`"  "`), true},
		{[]byte(`"\u0000"`), true},
		{[]byte(`"unterminated`), true},
	} {
		if got := Marked(c.raw); got != c.want {
			t.Errorf("Marked(%s) = %v, want %v", c.raw, got, c.want)
		}
	}
}

// imageDB answers the marker read for image 8101, owned by 1001: (owner, marker JSON), no row for any
// other id.
func imageDB(marker any, binds *[]any) *testkit.DB {
	return &testkit.DB{Routes: []testkit.Route{{
		Match: `FROM "Image" WHERE "id" = $1`,
		Rows: func(args []any) (*testkit.Rows, error) {
			*binds = append(*binds, args...)
			rows := testkit.NewRows([]string{"userId", "marker"})
			if len(args) == 1 && args[0] == int32(8101) {
				rows = testkit.NewRows([]string{"userId", "marker"}, []any{1001, marker})
			}
			return rows, nil
		},
	}}}
}

func req(id float64, viewer *Viewer) Request {
	return Request{Input: &Input{ID: id}, Viewer: viewer}
}

// Serve: the answer is null and served exactly when the image has no marker or does not exist, with
// the viewer class; a marker falls back; nothing is read for an id int4 cannot hold.
func TestServe(t *testing.T) {
	ctx := context.Background()
	stranger := &Viewer{ID: 1002}
	owner := &Viewer{ID: 1001}
	mod := &Viewer{ID: 1004, IsModerator: true}
	for _, c := range []struct {
		name    string
		marker  any
		req     Request
		reason  string
		class   string
		trivial bool
		binds   []any
	}{
		{"no marker, signed out", nil, req(8101, nil), "", ViewerAnon, false, []any{int32(8101)}},
		{"no marker, a stranger", nil, req(8101, stranger), "", ViewerUser, false, []any{int32(8101)}},
		{"no marker, the owner", nil, req(8101, owner), "", ViewerOwner, false, []any{int32(8101)}},
		{"no marker, the owner is a moderator first", nil, req(8101, &Viewer{ID: 1001, IsModerator: true}), "", ViewerModerator, false, []any{int32(8101)}},
		{"no marker, a moderator", nil, req(8101, mod), "", ViewerModerator, false, []any{int32(8101)}},
		{"a null marker", "null", req(8101, stranger), "", ViewerUser, false, []any{int32(8101)}},
		{"a number marker", "42", req(8101, stranger), "", ViewerUser, false, []any{int32(8101)}},
		{"an empty marker", `""`, req(8101, stranger), "", ViewerUser, false, []any{int32(8101)}},
		{"no such image", nil, req(8199, owner), "", ViewerUser, false, []any{int32(8199)}},
		{"a negative id reads", nil, req(-3, nil), "", ViewerAnon, false, []any{int32(-3)}},
		{"an id past int4 reads nothing", nil, req(2147483648, stranger), "", ViewerUser, true, nil},
		{"a fraction reads nothing", nil, req(8101.5, nil), "", ViewerAnon, true, nil},
		{"a marker", `"appblk-sketchpad"`, req(8101, stranger), "published-app-marked", "", false, []any{int32(8101)}},
		{"a whitespace marker", `"  "`, req(8101, owner), "published-app-marked", "", false, []any{int32(8101)}},
		{"banned", nil, Request{Input: &Input{ID: 8101}, Banned: true}, "published-app-banned-session", "", false, nil},
	} {
		var binds []any
		db := imageDB(c.marker, &binds)
		ans, err := Serve(ctx, &Deps{DB: db}, c.req)
		if got := fallback.Reason(err); got != c.reason {
			t.Errorf("%s: reason %q (%v), want %q", c.name, got, err, c.reason)
			continue
		}
		if len(binds) != len(c.binds) || (len(binds) == 1 && binds[0] != c.binds[0]) {
			t.Errorf("%s: bound %#v, want %#v", c.name, binds, c.binds)
		}
		if c.reason != "" {
			continue
		}
		if ans.Value != nil || ans.ViewerClass != c.class || ans.Trivial != c.trivial {
			t.Errorf("%s: %+v, want value nil, class %q, trivial %v", c.name, ans, c.class, c.trivial)
		}
	}
}

// The read is the one statement pinned here: the image's owner and the marker key's value by primary
// key, with no visibility term (the served answer does not depend on one).
func TestServeStatement(t *testing.T) {
	var sql string
	db := &testkit.DB{Routes: []testkit.Route{{Match: `FROM "Image"`, SQLRows: func(s string, _ []any) (*testkit.Rows, error) {
		sql = s
		return testkit.NewRows([]string{"userId", "marker"}), nil
	}}}}
	if _, err := Serve(context.Background(), &Deps{DB: db}, req(8101, nil)); err != nil {
		t.Fatal(err)
	}
	want := `SELECT "userId", "metadata" -> 'blockPublishedAppId' FROM "Image" WHERE "id" = $1`
	if sql != want {
		t.Fatalf("statement\n%s\nwant\n%s", sql, want)
	}
	if !strings.Contains(sql, "'"+MarkerKey+"'") {
		t.Fatal("the statement does not read MarkerKey")
	}
}

// A store error is returned as is (an error, not a fallback, and never a null answer: Node's fail-open
// null is not this read's to claim); no deps is its own fallback.
func TestServeErrors(t *testing.T) {
	boom := errors.New("replica down")
	db := &testkit.DB{Routes: []testkit.Route{{Match: `FROM "Image"`, Rows: func([]any) (*testkit.Rows, error) { return nil, boom }}}}
	ans, err := Serve(context.Background(), &Deps{DB: db}, req(8101, nil))
	if !errors.Is(err, boom) || ans != nil || fallback.Reason(err) != "" {
		t.Fatalf("store error: %v, %v", ans, err)
	}
	for _, d := range []*Deps{nil, {}} {
		if _, err := Serve(context.Background(), d, req(8101, nil)); fallback.Reason(err) != "published-app-unconfigured" {
			t.Fatalf("deps %v: %v", d, err)
		}
	}
}
