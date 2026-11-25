package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/civitai/civitai/apps/app-data-go/internal/metrics"
	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/writes"
)

// Read-your-writes end to end (WRITES-DESIGN.md, "Read-your-writes"): the real write forwarder, the
// real session manager and registry client, a fake site that answers each write with its seq and
// record id, and the fake adapter, whose stream never polls again after its snapshot, so anything a
// read shows beyond the snapshot came from an acknowledgement.

// keyedEnt is a private record as the adapter's private feed sends it, with its key and seq.
func keyedEnt(id, k string, seq int64, canary string) registry.Entity {
	e := ent("urn:apps.civitai.com:todo-app/notes/"+id, canary)
	e.Key, e.Seq = k, seq
	return e
}

// fakeWriteSite is the site's internal storage route: a put answers its record at the next seq, a
// create mints its key, a delete answers its tombstone's seq.
type fakeWriteSite struct {
	srv  *httptest.Server
	mu   sync.Mutex
	seq  int64
	sent atomic.Int32
}

func newFakeWriteSite(t *testing.T, from int64) *fakeWriteSite {
	t.Helper()
	f := &fakeWriteSite{seq: from}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.sent.Add(1)
		f.mu.Lock()
		f.seq++
		seq := f.seq
		f.mu.Unlock()
		var in struct {
			Data json.RawMessage `json:"data"`
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &in)
		k := strings.TrimPrefix(r.URL.Path, writes.InternalPath+"/notes/")
		w.Header().Set("Content-Type", "application/json")
		switch r.Method {
		case http.MethodDelete:
			_, _ = fmt.Fprintf(w, `{"deleted":true,"seq":%d}`, seq)
			return
		case http.MethodPost:
			k = fmt.Sprintf("minted-%d", seq)
			w.WriteHeader(http.StatusCreated)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"key": k, "data": in.Data, "version": 1, "seq": seq,
			"recordId": "rid-" + k, "createdAt": "2026-11-23T00:00:00.000Z", "updatedAt": "2026-11-23T00:00:00.000Z"})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// newWritesStack is newStack with the registry path on, read-your-writes on (an overlay lives 90 s, a
// floor reopens at most every minute), and the writes forwarded to site, wired as main wires them.
func newWritesStack(t *testing.T, site *fakeWriteSite) *stack {
	t.Helper()
	var m *metrics.Metrics
	s := newStack(t, true, session.Options{OverlayTTL: 90 * time.Second, ReopenEvery: time.Minute,
		Overlaid: func(kind string) { m.Overlays.WithLabelValues(kind).Inc() }})
	m = s.m
	base, _ := url.Parse(site.srv.URL)
	s.srv.Writes = &writes.Forwarder{Site: base, Key: []byte("api-test-signing-key-0123456789-abc"),
		Timeout: 2 * time.Second, Metrics: s.m, Acked: s.mgr.Ack}
	s.h = s.srv.Handler()
	return s
}

type keyedGot struct {
	status int
	header http.Header
	body   string
	ans    keyed
	err    struct {
		Error string `json:"error"`
	}
}

func (s *stack) getKey(t *testing.T, path, token string) keyedGot {
	t.Helper()
	rec := s.call(t, http.MethodGet, path, token, "")
	g := keyedGot{status: rec.Code, header: rec.Header(), body: rec.Body.String()}
	_ = json.Unmarshal(rec.Body.Bytes(), &g.ans)
	_ = json.Unmarshal(rec.Body.Bytes(), &g.err)
	return g
}

// itemsOf is a list answer as key=data, in order.
func itemsOf(g got) string {
	out := make([]string, 0, len(g.ans.Items))
	for _, it := range g.ans.Items {
		out = append(out, it.Key+"="+string(it.Data))
	}
	return strings.Join(out, ",")
}

// An acknowledged write is read back on the same token before the adapter polls again, on the list
// and on the keyed get: a put, a create, a delete. Another token's reads never change.
// Fails on origin/main: Forwarder has no Acked field there (the test does not compile); the
// behavioural assertion is the list showing `note-1={"text":"PUT-31"}` after the put.
func TestAnAcknowledgedWriteIsReadBackBeforeAnyPoll(t *testing.T) {
	site := newFakeWriteSite(t, 30)
	s := newWritesStack(t, site)
	s.reg.records["civitai_alice"] = []registry.Entity{keyedEnt("rid-note-1", "note-1", 20, "BASE-20")}
	s.reg.heads["civitai_alice"] = 25
	s.reg.records["civitai_bob"] = []registry.Entity{keyedEnt("rid-bob-1", "note-1", 21, "BOB-21")}
	s.reg.heads["civitai_bob"] = 25
	for _, tok := range []string{"civitai_alice", "civitai_bob"} {
		if g := s.get(t, notesPath, tok); g.ans.Source != "registry" {
			t.Fatalf("%s: %s", tok, g.body)
		}
	}

	if rec := s.call(t, http.MethodPut, notesPath+"/note-1", "civitai_alice", `{"data":{"text":"PUT-31"}}`); rec.Code != 200 {
		t.Fatalf("put: %d %s", rec.Code, rec.Body)
	}
	if g := s.get(t, notesPath, "civitai_alice"); itemsOf(g) != `note-1={"text":"PUT-31"}` || g.ans.Items[0].URN != "urn:apps.civitai.com:todo-app/notes/rid-note-1" {
		t.Fatalf("after the put: %s", g.body)
	}
	if g := s.getKey(t, notesPath+"/note-1", "civitai_alice"); g.status != 200 || string(g.ans.Item.Data) != `{"text":"PUT-31"}` || g.ans.Item.Rev != "seq.31" {
		t.Fatalf("keyed get after the put: %d %s", g.status, g.body)
	}
	if rec := s.call(t, http.MethodPost, notesPath, "civitai_alice", `{"data":{"text":"CREATE-32"}}`); rec.Code != 201 {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	// Ordered by URN: rid-minted-32 before rid-note-1.
	if g := s.get(t, notesPath, "civitai_alice"); itemsOf(g) != `minted-32={"text":"CREATE-32"},note-1={"text":"PUT-31"}` {
		t.Fatalf("after the create: %s", g.body)
	}
	if rec := s.call(t, http.MethodDelete, notesPath+"/note-1", "civitai_alice", ""); rec.Code != 200 {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	if g := s.get(t, notesPath, "civitai_alice"); itemsOf(g) != `minted-32={"text":"CREATE-32"}` {
		t.Fatalf("after the delete: %s", g.body)
	}
	if g := s.getKey(t, notesPath+"/note-1", "civitai_alice"); g.status != 404 || g.err.Error != "not_found" {
		t.Fatalf("keyed get after the delete: %d %s", g.status, g.body)
	}
	// A floor at the last acknowledgement: a hub token's is the head alone, so it is refused, never
	// read from REST.
	if g := s.get(t, notesPath+"?minSeq=33", "civitai_alice"); g.status != 503 || s.store.calls.Load() != 0 {
		t.Fatalf("a hub token's floor above the head: %d %s, %d REST reads", g.status, g.body, s.store.calls.Load())
	}
	if g := s.get(t, notesPath, "civitai_bob"); itemsOf(g) != `note-1={"text":"BOB-21"}` {
		t.Fatalf("🔴 another token's read changed: %s", g.body)
	}
	if site.sent.Load() != 3 {
		t.Fatalf("the site was sent %d writes, want 3", site.sent.Load())
	}
	if n := testutil.ToFloat64(s.m.Overlays.WithLabelValues("record")); n != 2 {
		t.Fatalf("%v record overlays, want 2", n)
	}
	if n := testutil.ToFloat64(s.m.Overlays.WithLabelValues("delete_marker")); n != 1 {
		t.Fatalf("%v delete markers, want 1", n)
	}
}

// A read's floor (writes on): met by the head, the registry's answer; above it, `503 floor_not_met`
// with Retry-After after the one reopen, and no REST read; malformed, 400. Writes off, `minSeq` is
// not read at all: the read answers as before.
// Fails on origin/main: `minSeq` is ignored there, so the read above the head answers 200
// (`g.status != 503`).
func TestAReadsFloorIsAnsweredOrRefusedNeverReadFromREST(t *testing.T) {
	s := newWritesStack(t, newFakeWriteSite(t, 0))
	s.reg.records["civitai_carol"] = []registry.Entity{keyedEnt("rid-c1", "c-1", 30, "CAROL-30")}
	s.reg.heads["civitai_carol"] = 30
	if g := s.get(t, notesPath+"?minSeq=30", "civitai_carol"); g.status != 200 || g.ans.Source != "registry" {
		t.Fatalf("a floor the head meets: %d %s", g.status, g.body)
	}
	g := s.get(t, notesPath+"?minSeq=31", "civitai_carol")
	if g.status != 503 || g.header.Get("Retry-After") != "1" || !strings.Contains(g.body, `"floor_not_met"`) || s.store.calls.Load() != 0 {
		t.Fatalf("a floor above the head: %d %v %s, %d REST reads", g.status, g.header, g.body, s.store.calls.Load())
	}
	if n := s.reg.subs.Load(); n != 2 {
		t.Fatalf("%d subscriptions, want 2 (one reopen)", n)
	}
	if n := testutil.ToFloat64(s.m.Reads.WithLabelValues("registry", "floor_not_met")); n != 1 {
		t.Fatalf("%v floor_not_met reads counted", n)
	}
	for _, q := range []string{"?minSeq=x", "?minSeq=-1", "?minSeq=1&minSeq=2", "?minSeq=1234567890123456"} {
		if g := s.get(t, notesPath+q, "civitai_carol"); g.status != 400 {
			t.Errorf("%s: %d %s, want 400", q, g.status, g.body)
		}
	}

	off := newStack(t, true, session.Options{})
	off.reg.records["civitai_carol"] = []registry.Entity{keyedEnt("rid-c1", "c-1", 30, "CAROL-30")}
	off.reg.heads["civitai_carol"] = 30
	for _, q := range []string{"?minSeq=x", "?minSeq=99"} {
		if g := off.get(t, notesPath+q, "civitai_carol"); g.status != 200 || g.ans.Source != "registry" {
			t.Errorf("writes off, %s: %d %s; want the read unchanged", q, g.status, g.body)
		}
	}
}

// The keyed get answers from the stream only: the record (the newer of two rows of one key), a 404 for
// a key it does not hold or a stream that holds nothing, and each refusal as its code. Writes off it
// is the mux's 404.
// Fails on origin/main: with writes on, GET of the key path is the mux's 405 there (only PUT, DELETE
// and OPTIONS are registered), so `g.status != 200` fails.
func TestTheKeyedGetIsAnsweredFromTheStreamOnly(t *testing.T) {
	s := newWritesStack(t, newFakeWriteSite(t, 0))
	s.reg.records["civitai_dave"] = []registry.Entity{
		keyedEnt("rid-d-old", "d-1", 40, "D-OLD-ROW"), keyedEnt("rid-d-new", "d-1", 41, "D-NEW-ROW"),
		keyedEnt("rid-d2", "d-2", 42, "D-2"),
	}
	s.reg.heads["civitai_dave"] = 50
	s.reg.records["civitai_unkeyed"] = []registry.Entity{ent("urn:apps.civitai.com:todo-app/notes/r-u", "UNKEYED")}
	s.reg.notPrivate["civitai_shared"] = true
	s.reg.records["civitai_shared"] = []registry.Entity{keyedEnt("rid-s", "s-1", 1, "SHARED")}
	g := s.getKey(t, notesPath+"/d-1", "civitai_dave")
	if g.status != 200 || g.ans.Source != "registry" || g.ans.Item.Key != "d-1" || g.ans.Item.URN != "urn:apps.civitai.com:todo-app/notes/rid-d-new" ||
		string(g.ans.Item.Data) != `{"text":"D-NEW-ROW"}` || g.header.Get("Cache-Control") != "private, no-store" || g.header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("%d %v %s", g.status, g.header, g.body)
	}
	cases := []struct {
		path, token string
		status      int
		code        string
	}{
		{notesPath + "/d-9", "civitai_dave", 404, "not_found"},
		{notesPath + "/e-1", "civitai_empty", 404, "not_found"},
		{notesPath + "/u-1", "civitai_unkeyed", 503, "unkeyed"},
		{notesPath + "/s-1", "civitai_shared", 501, "not_private"},
		{notesPath + "/d-1", "not-an-app-token", 401, "token_not_exchangeable"},
		{notesPath + "/d-1", "", 401, "unauthenticated"},
		{notesPath + "/bad%20key", "civitai_dave", 400, "bad_request"},
		{notesPath + "/d-1?major=x", "civitai_dave", 400, "bad_request"},
		{"/v1/apps/Bad/collections/notes/records/d-1", "civitai_dave", 400, "bad_request"},
		{notesPath + "/d-1?minSeq=x", "civitai_dave", 400, "bad_request"},
		{notesPath + "/d-1?minSeq=51", "civitai_dave", 503, "floor_not_met"},
		// A stream that names no head answers a floored read unfloored.
		{notesPath + "/s-2?minSeq=51", "civitai_empty", 404, "not_found"},
	}
	for _, c := range cases {
		g := s.getKey(t, c.path, c.token)
		if g.status != c.status || g.err.Error != c.code {
			t.Errorf("%s as %q: %d %s; want %d %s", c.path, c.token, g.status, g.body, c.status, c.code)
		}
	}
	if s.store.calls.Load() != 0 {
		t.Fatalf("🔴 the keyed get read REST %d times", s.store.calls.Load())
	}

	off := newStack(t, true, session.Options{})
	off.reg.records["civitai_dave"] = s.reg.records["civitai_dave"]
	if g := off.getKey(t, notesPath+"/d-1", "civitai_dave"); g.status != 404 {
		t.Fatalf("writes off: %d %s; want the mux's 404", g.status, g.body)
	}
	noReg := newStack(t, false, session.Options{})
	noReg.srv.Writes = s.srv.Writes
	noReg.h = noReg.srv.Handler()
	if g := noReg.getKey(t, notesPath+"/d-1", "civitai_dave"); g.status != 503 || g.err.Error != "registry_off" || g.header.Get("Retry-After") != "1" {
		t.Fatalf("registry off: %d %v %s", g.status, g.header, g.body)
	}
}

// Every reason a stream cannot answer has its answer for a read that is not read from REST
// (WRITES-DESIGN.md, the fallback-reason table): the token's own refusals 401 (a spent block token as
// `block_token_spent`), a collection the private feed does not serve 501, the rest 503 with
// Retry-After. Fails on origin/main: there is no streamRefusal (the test does not compile).
func TestEveryStreamReasonHasAnAnswer(t *testing.T) {
	// `empty` is not among them: an empty stream is an empty answer (the keyed get's 404), never a
	// refusal.
	want := map[string][2]any{
		"registry_off": {503, "registry_off"}, "token_not_exchangeable": {401, "token_not_exchangeable"},
		"capacity": {503, "capacity"}, "token_capacity": {503, "token_capacity"},
		"not_live": {503, "not_live"}, "stalled": {503, "stalled"}, "cooling_down": {503, "cooling_down"},
		"invalid_token": {401, "invalid_token"}, "exchange_refused": {401, "exchange_refused"},
		"not_private": {501, "not_private"}, "too_large": {503, "too_large"}, "ended": {503, "ended"},
		"failed": {503, "failed"}, "closed": {503, "closed"}, "block_spent": {401, "block_token_spent"},
		"block_cache_full": {503, "block_cache_full"}, "unkeyed": {503, "unkeyed"},
		"cursor_expired": {503, "cursor_expired"}, "floor_not_met": {503, "floor_not_met"},
	}
	for _, r := range metrics.FallbackReasons {
		if _, ok := want[r]; !ok && r != "empty" {
			t.Errorf("declared reason %q has no expected answer here", r)
		}
	}
	if len(want) != len(metrics.FallbackReasons) {
		t.Fatalf("%d reasons here, %d declared (less empty, plus floor_not_met)", len(want), len(metrics.FallbackReasons))
	}
	s := newStack(t, false, session.Options{})
	for reason, w := range want {
		rec := httptest.NewRecorder()
		s.srv.streamRefusal(rec, time.Now(), reason)
		var body struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != w[0] || body.Error != w[1] {
			t.Errorf("%s: %d %s; want %v %v", reason, rec.Code, body.Error, w[0], w[1])
		}
		if retry := rec.Header().Get("Retry-After"); (rec.Code == 503) != (retry == "1") {
			t.Errorf("%s: %d with Retry-After %q", reason, rec.Code, retry)
		}
	}
}

// A stream that holds nothing and names no head (the origin's answer to a token it refuses) still
// sends the list to REST after an acknowledged write: an overlay never turns it into a one-record
// registry answer.
// Fails on 3c012af11b: the list answered `source: registry` with the overlay record alone.
func TestAnAckNeverTurnsARefusedStreamIntoARegistryAnswer(t *testing.T) {
	s := newWritesStack(t, newFakeWriteSite(t, 60))
	s.store.by["civitai_erin"] = restAnswer{200, `{"items":[{"key":"e-1","data":{"text":"REST-E1"},"version":3}],"nextCursor":null}`}
	if g := s.get(t, notesPath, "civitai_erin"); g.ans.Source != "rest" {
		t.Fatalf("before: %s", g.body)
	}
	if rec := s.call(t, http.MethodPut, notesPath+"/e-2", "civitai_erin", `{"data":{"text":"PUT-61"}}`); rec.Code != 200 {
		t.Fatalf("put: %d %s", rec.Code, rec.Body)
	}
	if g := s.get(t, notesPath, "civitai_erin"); g.ans.Source != "rest" || itemsOf(g) != `e-1={"text":"REST-E1"}` {
		t.Fatalf("after the put: %s; want the REST answer", g.body)
	}
}
