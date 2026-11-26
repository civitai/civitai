package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-data-go/internal/exchange"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/shared"
)

// SHARED COLLECTIONS through the handler (shared.go): the real handler and private-stream stack, with
// the shared reader faked so each answer is the board the case sets. Every key, seq and canary is
// distinct.

type fakeShared struct {
	mu     sync.Mutex
	board  shared.Board
	err    error
	viewer []shared.Viewer
	args   []string
}

func (f *fakeShared) Read(_ context.Context, v shared.Viewer, slug, collection string, major int, minSeq int64) (shared.Board, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.viewer = append(f.viewer, v)
	f.args = append(f.args, fmt.Sprintf("%s/%s@%d>%d", slug, collection, major, minSeq))
	b := f.board
	if b.Current == 0 {
		// The streams name the major read as current, as the adapter does for a collection's newest.
		b.Current = major
	}
	return b, f.err
}

func (f *fakeShared) reads() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.viewer)
}

func sdoc(key, canary string, mine bool) shared.Doc {
	return shared.Doc{URN: "urn:apps.civitai.com:todo-app/notes/" + key, Key: key, Rev: "r-" + key,
		Data: json.RawMessage(fmt.Sprintf(`{"t":%q}`, canary)), Version: int64(len(canary)), CreatedAt: "c-" + key, UpdatedAt: "u-" + key, Mine: mine}
}

// newSharedStack is newWritesStack with a shared reader: the private feed answers "not this feed"
// for civitai_shared-* tokens, so their reads take the shared path.
func newSharedStack(t *testing.T) (*stack, *fakeShared) {
	t.Helper()
	s := newWritesStack(t, newFakeWriteSite(t, 0))
	f := &fakeShared{}
	s.srv.Shared = f
	s.h = s.srv.Handler()
	return s, f
}

type sharedGot struct {
	status int
	header http.Header
	body   string
	list   sharedList
	one    sharedOne
	err    struct {
		Error, Code string
		Details     map[string]string
	}
}

func (s *stack) shared(t *testing.T, path, token string) sharedGot {
	t.Helper()
	rec := s.call(t, http.MethodGet, path, token, "")
	g := sharedGot{status: rec.Code, header: rec.Header(), body: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &g.list)
	_ = json.Unmarshal(rec.Body.Bytes(), &g.one)
	_ = json.Unmarshal(rec.Body.Bytes(), &g.err)
	return g
}

func keys(l sharedList) string {
	out := make([]string, 0, len(l.Items))
	for _, it := range l.Items {
		k := it.Key
		if it.Author.IsViewer {
			k += "*"
		}
		out = append(out, k)
	}
	return strings.Join(out, ",")
}

func cursorOf(l sharedList) string {
	if l.NextCursor == nil {
		return "<nil>"
	}
	return *l.NextCursor
}

// A collection the private feed does not serve is read from the shared path, never REST, and the
// schema is remembered: the next token's read goes there without opening a private stream. Pages
// follow the store's own key sort, limit and cursor; keyPrefix and author=me filter.
func TestASharedCollectionIsPagedFromTheSharedPath(t *testing.T) {
	s, f := newSharedStack(t)
	s.reg.notPrivate["civitai_shared-a"] = true
	f.board = shared.Board{Docs: []shared.Doc{sdoc("p:1", "P1", false), sdoc("p:2", "P2-MINE", true), sdoc("q:1", "Q1", false),
		sdoc("q:2", "Q2", false), sdoc("r:1", "R1-MINE", true)}}
	g := s.shared(t, notesPath+"?limit=2&minSeq=7", "civitai_shared-a")
	if g.status != 200 || g.list.Source != "registry" || keys(g.list) != "p:1,p:2*" || cursorOf(g.list) != "ka~~p:2" ||
		g.header.Get("Cache-Control") != "private, no-store" || g.header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("first page: %d %s", g.status, g.body)
	}
	it := g.list.Items[1]
	if it.URN != "urn:apps.civitai.com:todo-app/notes/p:2" || string(it.Data) != `{"t":"P2-MINE"}` || it.Version != 7 ||
		it.CreatedAt != "c-p:2" || it.UpdatedAt != "u-p:2" || it.Rev != "r-p:2" {
		t.Fatalf("a presented document: %+v", it)
	}
	// No major: an unfloored read learns the current major (major.go), then the floored read at it.
	if strings.Join(f.args, " ") != "todo-app/notes@1>0 todo-app/notes@1>7" || f.viewer[0].Token != "civitai_shared-a" || f.viewer[0].Anonymous != nil {
		t.Fatalf("read as %v %+v", f.args, f.viewer)
	}
	subs := s.reg.subs.Load()
	// Another token: straight to the shared path (the memo), no private stream opened.
	g = s.shared(t, notesPath+"?limit=2&cursor=ka~~p:2", "civitai_other-b")
	if g.status != 200 || keys(g.list) != "q:1,q:2" || cursorOf(g.list) != "ka~~q:2" || s.reg.subs.Load() != subs {
		t.Fatalf("second page: %d %s, %d more subscriptions", g.status, g.body, s.reg.subs.Load()-subs)
	}
	g = s.shared(t, notesPath+"?limit=2&cursor=ka~~q:2", "civitai_other-b")
	if keys(g.list) != "r:1*" || cursorOf(g.list) != "<nil>" {
		t.Fatalf("last page: %s", g.body)
	}
	for q, want := range map[string]string{
		"?sort=-key&limit=3":                 "r:1*,q:2,q:1",
		"?sort=-key&cursor=kd~~q:1":          "p:2*,p:1",
		"?keyPrefix=q:":                      "q:1,q:2",
		"?author=me":                         "p:2*,r:1*",
		"?author=me&keyPrefix=r:&sort=-key":  "r:1*",
		"?keyPrefix=zz":                      "",
		"?sort=key&limit=100&cursor=ka~~q:9": "r:1*",
	} {
		if g := s.shared(t, notesPath+q, "civitai_other-b"); g.status != 200 || keys(g.list) != want {
			t.Errorf("%s: %d %s, want %s", q, g.status, g.body, want)
		}
	}
	for q, code := range map[string]string{
		"?where[a]=1": "not_supported_here", "?sort=createdAt": "not_supported_here", "?mark=vote": "not_supported_here",
		"?limit=0": "bad_request", "?limit=101": "bad_request", "?limit=1e2": "bad_request", "?author=you": "bad_request",
		"?cursor=kd~~p:1": "bad_request", "?sort=-key&cursor=ka~~p:1": "bad_request", "?cursor=garbage": "bad_request",
		"?limit=1&limit=2": "bad_request",
	} {
		if g := s.shared(t, notesPath+q, "civitai_other-b"); g.status != 400 || g.err.Error != code || g.err.Code != code {
			t.Errorf("%s: %d %s, want 400 %s", q, g.status, g.body, code)
		}
	}
	if s.store.calls.Load() != 0 {
		t.Fatalf("🔴 a shared read reached REST %d times", s.store.calls.Load())
	}
}

// THE WINDOW: below a truncated level stream's lowest key the board is not known. An ascending page
// starting there, a descending page that would reach there, and a get of a key there are `503
// too_large`; a page whose prefix sorts at or above the floor, and the viewer's own documents, are
// answered.
func TestAnAnswerBelowTheWindowIsTooLarge(t *testing.T) {
	s, f := newSharedStack(t)
	s.reg.notPrivate["civitai_shared-w"] = true
	f.board = shared.Board{Floor: "m", Docs: []shared.Doc{sdoc("a-own", "A", true), sdoc("m", "M", false), sdoc("n", "N", false),
		sdoc("o", "O", false)}}
	cases := []struct {
		q      string
		status int
		want   string
	}{
		{"", 503, ""},
		{"?cursor=ka~~b", 503, ""},
		{"?cursor=ka~~m", 200, "n,o"},
		{"?sort=-key&limit=2", 200, "o,n"},
		{"?sort=-key&limit=3", 200, "o,n,m"},
		{"?sort=-key&limit=4", 503, ""},
		{"?sort=-key&cursor=kd~~n&limit=1", 200, "m"},
		{"?sort=-key&cursor=kd~~m", 503, ""},
		{"?keyPrefix=n", 200, "n"},
		{"?keyPrefix=a", 503, ""},
		{"?author=me", 200, "a-own*"},
	}
	for _, c := range cases {
		g := s.shared(t, notesPath+c.q, "civitai_shared-w")
		if g.status != c.status || (c.status == 200 && keys(g.list) != c.want) || (c.status == 503 && (g.err.Error != "too_large" || g.header.Get("Retry-After") != "1")) {
			t.Errorf("%q: %d %s; want %d %s", c.q, g.status, g.body, c.status, c.want)
		}
	}
	for path, status := range map[string]int{"/n": 200, "/a-own": 200, "/b": 503, "/zz": 404} {
		g := s.shared(t, notesPath+path, "civitai_shared-w")
		if g.status != status || (status == 200 && g.one.Item.Key != strings.TrimPrefix(path, "/")) {
			t.Errorf("get %s: %d %s, want %d", path, g.status, g.body, status)
		}
	}
	if g := s.shared(t, notesPath+"/a-own", "civitai_shared-w"); !g.one.Item.Author.IsViewer || g.one.Source != "registry" {
		t.Fatalf("own get: %s", g.body)
	}
}

// THE VIEWER'S OWN DOCUMENT: found among their own documents by the derived key's shape, never by
// deriving it; each misuse of the route is the store's own `400 invalid_request` reason.
func TestTheViewersOwnDocumentIsFoundAmongTheirOwn(t *testing.T) {
	s, f := newSharedStack(t)
	s.reg.notPrivate["civitai_shared-v"] = true
	// Another viewer's document of the same parent, and the viewer's own one of another parent.
	f.board = shared.Board{KeyedBy: "parent+viewer", Docs: []shared.Doc{
		sdoc("rec-1:abcdefghijklmnopqrstuvwxyz", "THEIRS", false),
		sdoc("rec-1:bcdefghijklmnopqrstuvwxyz2", "MINE-1", true),
		sdoc("rec-2:cdefghijklmnopqrstuvwxyz23", "MINE-2", true),
		sdoc("rec-3:not-derived", "MINE-ODD", true),
	}}
	// The schema is learned on the first read (the memo), as any shared read.
	_ = s.shared(t, notesPath, "civitai_shared-v")
	if g := s.shared(t, notesPath+"/@me/rec-1", "civitai_shared-v"); g.status != 200 || string(g.one.Item.Data) != `{"t":"MINE-1"}` || !g.one.Item.Author.IsViewer {
		t.Fatalf("@me/rec-1: %d %s", g.status, g.body)
	}
	for path, want := range map[string][2]string{
		"/@me/rec-3":    {"404", "not_found"},
		"/@me/rec-9":    {"404", "not_found"},
		"/@me":          {"400", "parent_required"},
		"/@me/a:b":      {"400", "invalid_request"},
		"/@me/...":      {"400", "invalid_request"},
		"/@me/rec-1?x=": {"200", ""},
	} {
		g := s.shared(t, notesPath+path, "civitai_shared-v")
		if strconv.Itoa(g.status) != want[0] || (want[0] == "400" && want[1] != "invalid_request" && g.err.Details["reason"] != want[1]) ||
			(want[0] == "404" && g.err.Error != want[1]) {
			t.Errorf("%s: %d %s, want %v", path, g.status, g.body, want)
		}
	}
	f.board = shared.Board{KeyedBy: "viewer", Docs: []shared.Doc{sdoc("defghijklmnopqrstuvwxyz234", "ONLY", true)}}
	if g := s.shared(t, notesPath+"/@me", "civitai_shared-v"); g.status != 200 || string(g.one.Item.Data) != `{"t":"ONLY"}` {
		t.Fatalf("@me: %d %s", g.status, g.body)
	}
	if g := s.shared(t, notesPath+"/@me/rec-1", "civitai_shared-v"); g.status != 400 || g.err.Details["reason"] != "parent_not_allowed" {
		t.Fatalf("@me/parent on a viewer collection: %d %s", g.status, g.body)
	}
	f.board = shared.Board{}
	if g := s.shared(t, notesPath+"/@me", "civitai_shared-v"); g.status != 400 || g.err.Details["reason"] != "not_viewer_keyed" {
		t.Fatalf("@me on a collection without keyedBy: %d %s", g.status, g.body)
	}
	f.err = errors.New("boom")
	if g := s.shared(t, notesPath+"/@me", "civitai_shared-v"); g.status != 503 || g.err.Error != "failed" {
		t.Fatalf("an unreadable board: %d %s", g.status, g.body)
	}
	if g := s.shared(t, notesPath+"/@me", ""); g.status != 401 {
		t.Fatalf("no token: %d", g.status)
	}
}

// Every reason a shared read cannot be answered has its answer, never REST: the viewer's refusal and
// a token for another block 401 refused; a catalog lag (`not_resolved`) 503, never 401; a spent block
// token 401 block_token_spent; the rest 503 with Retry-After.
func TestEverySharedRefusalHasItsAnswer(t *testing.T) {
	s, f := newSharedStack(t)
	s.reg.notPrivate["civitai_shared-e"] = true
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{shared.ErrViewerRefused, 401, "refused"},
		{shared.ErrBlockMismatch, 401, "refused"},
		{shared.ErrUnkeyed, 503, "unkeyed"},
		{session.ErrFloorNotMet, 503, "floor_not_met"},
		{&session.EndedError{Reason: "not_resolved"}, 503, "not_resolved"},
		{errors.Join(session.ErrCoolingDown, &session.EndedError{Reason: "not_resolved"}), 503, "not_resolved"},
		{&session.EndedError{Reason: "levels_on"}, 503, "ended"},
		{session.ErrBlockSpent, 401, "block_token_spent"},
		{session.ErrRefused, 401, "exchange_refused"},
		{session.ErrInvalidToken, 401, "invalid_token"},
		{session.ErrNotLive, 503, "not_live"},
		{session.ErrTooLarge, 503, "too_large"},
		// 🔴 The level streams' own token refused is this service's fault, never the viewer's 401.
		{shared.ErrServiceToken, 503, "service_token_refused"},
		{shared.ErrSignedOutBusy, 503, "capacity"},
	}
	for _, c := range cases {
		f.err = c.err
		g := s.shared(t, notesPath, "civitai_shared-e")
		if g.status != c.status || g.err.Error != c.code || g.err.Code != c.code || (c.status == 503) != (g.header.Get("Retry-After") == "1") ||
			(c.status == 401) != (g.header.Get("WWW-Authenticate") != "") {
			t.Errorf("%v: %d %v %s; want %d %s", c.err, g.status, g.header, g.body, c.status, c.code)
		}
	}
	if s.store.calls.Load() != 0 {
		t.Fatalf("🔴 REST was read %d times", s.store.calls.Load())
	}
	// A token that cannot be exchanged, on a schema known to be shared, is refused before any read.
	before := f.reads()
	if g := s.shared(t, notesPath, "not-an-app-token"); g.status != 401 || g.err.Error != "token_not_exchangeable" || f.reads() != before {
		t.Fatalf("not exchangeable: %d %s", g.status, g.body)
	}
}

// anonToken is a block token's shape whose subject is the anonymous one; only its shape is read here,
// the verification is Anonymous's.
func anonToken(sub string) string {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"sub":"` + sub + `"}`))
	return "eyJhbGciOiJSUzI1NiJ9." + payload + ".c2ln"
}

// SIGNED-OUT: an anonymous block token reads the shared path at the mask of its own claims, for its
// own block, verified first; its refusals are its own; a private-only or a viewer's own read is
// `401 sign_in_required`. Each is counted.
func TestASignedOutViewerReadsTheSharedPath(t *testing.T) {
	s, f := newSharedStack(t)
	f.board = shared.Board{Docs: []shared.Doc{sdoc("pub-1", "PUB", false)}}
	maxL, viewerL := int64(31), int64(6)
	claims := exchange.AnonymousClaims{BlockID: "todo-app", AppBlockID: "apb_todo", MaxBrowsingLevel: &maxL, ViewerBrowsingLevel: &viewerL}
	var verifyErr error
	verified := 0
	s.srv.Anonymous = func(_ context.Context, token string) (exchange.AnonymousClaims, error) {
		verified++
		return claims, verifyErr
	}
	tok := anonToken("anon")
	g := s.shared(t, notesPath, tok)
	if g.status != 200 || keys(g.list) != "pub-1" || verified != 1 {
		t.Fatalf("signed out: %d %s (verified %d)", g.status, g.body, verified)
	}
	if v := f.viewer[len(f.viewer)-1]; v.Anonymous == nil || v.Anonymous.Mask != 6 || v.Anonymous.AppBlockID != "apb_todo" || v.Token != "" {
		t.Fatalf("read as %+v", v)
	}
	if g := s.shared(t, notesPath+"/pub-1", tok); g.status != 200 || g.one.Item.Author.IsViewer {
		t.Fatalf("signed-out get: %d %s", g.status, g.body)
	}
	if n := testutil.ToFloat64(s.m.SignedOutReads.WithLabelValues("ok")); n != 2 {
		t.Fatalf("%v signed-out ok reads counted", n)
	}
	if s.reg.subs.Load() != 0 || len(s.hub.subjects) != 0 {
		t.Fatalf("🔴 a signed-out token reached the adapter (%d) or the hub (%d)", s.reg.subs.Load(), len(s.hub.subjects))
	}
	for path, code := range map[string]string{notesPath + "?author=me": "sign_in_required", notesPath + "/@me": "sign_in_required"} {
		if g := s.shared(t, path, tok); g.status != 401 || g.err.Error != code {
			t.Errorf("%s: %d %s", path, g.status, g.body)
		}
	}
	claims.BlockID = "another-app"
	if g := s.shared(t, notesPath, tok); g.status != 401 || g.err.Error != "refused" {
		t.Fatalf("a token for another slug: %d %s", g.status, g.body)
	}
	claims.BlockID = "todo-app"
	verifyErr = &exchange.RefusedError{Code: exchange.LocalRefusalCode, Reason: "dev token"}
	if g := s.shared(t, notesPath, tok); g.status != 401 || g.err.Error != "unauthenticated" {
		t.Fatalf("a refused token: %d %s", g.status, g.body)
	}
	verifyErr = exchange.ErrBlockUnverifiable
	if g := s.shared(t, notesPath, tok); g.status != 503 || g.err.Error != "unverifiable" {
		t.Fatalf("an unverifiable token: %d %s", g.status, g.body)
	}
	s.srv.Anonymous = nil
	if g := s.shared(t, notesPath, tok); g.status != 401 || g.err.Error != "sign_in_required" {
		t.Fatalf("no verifier: %d %s", g.status, g.body)
	}
	// A signed-in block token's shape is not signed-out.
	if anonymousShape(anonToken("user:42")) || anonymousShape("civitai_x") || anonymousShape("a.!!.c") || !anonymousShape(tok) {
		t.Fatal("anonymousShape")
	}
}

// CUT OVER: with the writes on, a private read is never read from REST: an empty stream is an empty
// answer, and a stream that cannot answer is its refusal. The shadow's registry-only header keeps its
// `source: none` answer.
func TestACutOverPrivateReadNeverFallsBack(t *testing.T) {
	s := newWritesStack(t, newFakeWriteSite(t, 0))
	s.store.by["civitai_empty-c"] = restAnswer{200, `{"items":[{"key":"rest-1","data":{"t":"REST"},"version":1}],"nextCursor":null}`}
	if g := s.get(t, notesPath, "civitai_empty-c"); g.status != 200 || g.ans.Source != "registry" || len(g.ans.Items) != 0 {
		t.Fatalf("an empty stream: %d %s", g.status, g.body)
	}
	s.reg.records["civitai_unkeyed-c"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-u", "U")}
	if g := s.get(t, notesPath+"?keyPrefix=x", "civitai_unkeyed-c"); g.status != 503 || !strings.Contains(g.body, `"unkeyed"`) {
		t.Fatalf("unkeyed: %d %s", g.status, g.body)
	}
	if g := s.get(t, notesPath, "not-an-app-token"); g.status != 401 || !strings.Contains(g.body, `"token_not_exchangeable"`) {
		t.Fatalf("not exchangeable: %d %s", g.status, g.body)
	}
	s.reg.stall["civitai_stall-c"] = true
	if g := s.get(t, notesPath, "civitai_stall-c"); g.status != 503 || !strings.Contains(g.body, `"not_live"`) {
		t.Fatalf("a stream short of Live: %d %s", g.status, g.body)
	}
	// Not private, with no shared reader: the 501 of the table.
	s.reg.notPrivate["civitai_np-c"] = true
	if g := s.get(t, notesPath, "civitai_np-c"); g.status != 501 {
		t.Fatalf("not private without a shared reader: %d %s", g.status, g.body)
	}
	if s.store.calls.Load() != 0 {
		t.Fatalf("🔴 a cut-over read reached REST %d times", s.store.calls.Load())
	}
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, notesPath, http.NoBody)
	req.Header.Set("Authorization", "Bearer civitai_stall-c")
	req.Header.Set(RegistryOnlyHeader, "1")
	rec := httptest.NewRecorder()
	s.h.ServeHTTP(rec, req)
	if !strings.Contains(rec.Body.String(), `"source":"none"`) {
		t.Fatalf("the shadow's registry-only read: %d %s", rec.Code, rec.Body)
	}
	// Registry off, writes on: 503 registry_off, not REST.
	noReg := newStack(t, false, session.Options{})
	noReg.srv.Writes = s.srv.Writes
	noReg.h = noReg.srv.Handler()
	if g := noReg.get(t, notesPath, "civitai_empty-c"); g.status != 503 || !strings.Contains(g.body, `"registry_off"`) || noReg.store.calls.Load() != 0 {
		t.Fatalf("registry off: %d %s", g.status, g.body)
	}
}

// A keyed get is the first read of a shared collection: the private stream's "not this feed" sends it
// to the shared path too, and the schema is remembered from it. The memo forgets expired schemas.
func TestAKeyedGetLearnsASharedSchema(t *testing.T) {
	s, f := newSharedStack(t)
	s.reg.notPrivate["civitai_shared-g"] = true
	f.board = shared.Board{Docs: []shared.Doc{sdoc("g-1", "G1", false)}}
	if g := s.shared(t, notesPath+"/g-1", "civitai_shared-g"); g.status != 200 || g.one.Item.Key != "g-1" {
		t.Fatalf("first read a get: %d %s", g.status, g.body)
	}
	if !s.srv.shared.known(notesSchema, time.Now()) {
		t.Fatal("the schema was not remembered")
	}
	s.srv.shared.mark("urn:schema:apps.civitai.com:old-app/c@v1", time.Now().Add(-time.Hour))
	s.srv.shared.mark("urn:schema:apps.civitai.com:new-app/c@v1", time.Now())
	if s.srv.shared.known("urn:schema:apps.civitai.com:old-app/c@v1", time.Now()) || len(s.srv.shared.until) != 2 {
		t.Fatalf("an expired schema is forgotten: %v", s.srv.shared.until)
	}
	// A block-token shape whose payload is not base64url JSON is not signed-out.
	if anonymousShape("abc.b.c") {
		t.Fatal("an undecodable payload")
	}
}
