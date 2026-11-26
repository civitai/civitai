package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/app-data-go/internal/registry"
	"github.com/civitai/civitai/apps/app-data-go/internal/session"
	"github.com/civitai/civitai/apps/app-data-go/internal/writes"
)

// A private item carries its document's numeric `version`, the number the store compares a write's
// `ifVersion` against, on every read shape that answers private items: the registry list, the keyed
// get, an acknowledged write read back before the next poll, and the REST fallback. `rev` stays.
//
// The responses are decoded as plain JSON, not into `item`, so a missing field is a red assertion
// rather than a compile error.

// wireItem is one item as the wire carries it; Version is nil when the field is absent.
type wireItem struct {
	Key     string          `json:"key"`
	Rev     string          `json:"rev"`
	Data    json.RawMessage `json:"data"`
	Version *json.Number    `json:"version"`
}

func versionOf(it wireItem) string {
	if it.Version == nil {
		return "<absent>"
	}
	return it.Version.String()
}

func decodeList(t *testing.T, body string) []wireItem {
	t.Helper()
	var a struct {
		Items []wireItem `json:"items"`
	}
	d := json.NewDecoder(strings.NewReader(body))
	d.UseNumber()
	if err := d.Decode(&a); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	return a.Items
}

func decodeKeyed(t *testing.T, body string) wireItem {
	t.Helper()
	var a struct {
		Item wireItem `json:"item"`
	}
	d := json.NewDecoder(strings.NewReader(body))
	d.UseNumber()
	if err := d.Decode(&a); err != nil {
		t.Fatalf("decode %q: %v", body, err)
	}
	return a.Item
}

// versionsOf is a list's items as key=version, in order.
func versionsOf(items []wireItem) string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it.Key+"="+versionOf(it))
	}
	return strings.Join(out, ",")
}

// vent is a private record as the adapter's private feed sends it: key, seq and version.
func vent(id, k string, seq, version int64, canary string) registry.Entity {
	e := keyedEnt(id, k, seq, canary)
	e.Version = version
	return e
}

// Fails on origin/main: the item has no `version` (`n-a=<absent>`).
func TestAPrivateRegistryItemCarriesItsVersionOnTheListAndTheKeyedGet(t *testing.T) {
	s := newWritesStack(t, newFakeWriteSite(t, 0))
	// Versions pairwise distinct, distinct from every seq, and never 0 or 1 (the SDK's default and a
	// fresh document's).
	s.reg.records["civitai_vera"] = []registry.Entity{
		vent("rid-n-a", "n-a", 40, 7, "VER-A"), vent("rid-n-b", "n-b", 41, 12, "VER-B"),
	}
	s.reg.heads["civitai_vera"] = 50
	g := s.get(t, notesPath, "civitai_vera")
	if g.status != 200 || g.ans.Source != "registry" {
		t.Fatalf("list: %d %s", g.status, g.body)
	}
	items := decodeList(t, g.body)
	if got := versionsOf(items); got != "n-a=7,n-b=12" {
		t.Fatalf("list versions %s; want n-a=7,n-b=12 (%s)", got, g.body)
	}
	if items[0].Rev != "r-VER-A" {
		t.Fatalf("rev changed: %q", items[0].Rev)
	}
	k := s.getKey(t, notesPath+"/n-b", "civitai_vera")
	if k.status != 200 {
		t.Fatalf("keyed get: %d %s", k.status, k.body)
	}
	if it := decodeKeyed(t, k.body); versionOf(it) != "12" || it.Rev != "r-VER-B" {
		t.Fatalf("keyed get version %s rev %q; want 12, r-VER-B (%s)", versionOf(it), it.Rev, k.body)
	}
}

// Fails on origin/main: the REST item carries the version only as `rev` (`k1=<absent>`).
func TestAPrivateRESTItemCarriesItsVersion(t *testing.T) {
	s := newStack(t, false, session.Options{})
	s.store.by["civitai_rhea"] = restAnswer{200, `{"items":[{"key":"k1","data":{"text":"REST-V"},"version":23}],"nextCursor":null}`}
	g := s.get(t, notesPath, "civitai_rhea")
	if g.status != 200 || g.ans.Source != "rest" {
		t.Fatalf("%d %s", g.status, g.body)
	}
	items := decodeList(t, g.body)
	if got := versionsOf(items); got != "k1=23" || items[0].Rev != "23" {
		t.Fatalf("REST item %s rev %q; want k1=23, rev 23 (%s)", got, items[0].Rev, g.body)
	}
}

// versionSite is the site's internal storage route with the store's own version check (doc-store.ts
// `writeDoc`): a put whose `ifVersion` is not the document's current version is `409
// version_conflict`; otherwise the document's version goes up by one and the answer carries it.
type versionSite struct {
	srv      *httptest.Server
	mu       sync.Mutex
	seq      int64
	versions map[string]int64
}

func newVersionSite(t *testing.T, seq int64, versions map[string]int64) *versionSite {
	t.Helper()
	f := &versionSite{seq: seq, versions: versions}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Data      json.RawMessage `json:"data"`
			IfVersion *int64          `json:"ifVersion"`
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &in)
		k := strings.TrimPrefix(r.URL.Path, writes.InternalPath+"/notes/")
		w.Header().Set("Content-Type", "application/json")
		f.mu.Lock()
		defer f.mu.Unlock()
		cur := f.versions[k]
		if r.Method != http.MethodPut {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if in.IfVersion != nil && *in.IfVersion != cur {
			w.WriteHeader(http.StatusConflict)
			_, _ = fmt.Fprintf(w, `{"error":"version_conflict","message":"version conflict","currentVersion":%d}`, cur)
			return
		}
		f.seq++
		f.versions[k] = cur + 1
		_ = json.NewEncoder(w).Encode(map[string]any{"key": k, "data": in.Data, "version": cur + 1, "seq": f.seq,
			"recordId": "rid-" + k, "createdAt": "2026-11-23T00:00:00.000Z", "updatedAt": "2026-11-24T00:00:00.000Z"})
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// The SDK's read-then-write: a put whose `ifVersion` is the version a read answered is written; the
// read after it answers the new version (the write's acknowledgement, before any poll), and a put
// with the stale version is refused `version_conflict`, passed on as the site answered it.
// Fails on origin/main: the read carries no version, so there is nothing to put with
// (`read version <absent>`).
func TestAPutWithTheVersionAReadAnsweredIsWrittenAndAStaleOneIsRefused(t *testing.T) {
	site := newVersionSite(t, 60, map[string]int64{"c-1": 6})
	var m = newStack(t, true, session.Options{OverlayTTL: 90 * time.Second, ReopenEvery: time.Minute})
	base, _ := url.Parse(site.srv.URL)
	m.srv.Writes = &writes.Forwarder{Site: base, Key: []byte("api-test-signing-key-0123456789-abc"),
		Timeout: 2 * time.Second, Metrics: m.m, Acked: m.mgr.Ack}
	m.h = m.srv.Handler()
	m.reg.records["civitai_cleo"] = []registry.Entity{vent("rid-c-1", "c-1", 55, 6, "CHAR-6")}
	m.reg.heads["civitai_cleo"] = 60

	read := decodeKeyed(t, m.getKey(t, notesPath+"/c-1", "civitai_cleo").body)
	if versionOf(read) != "6" {
		t.Fatalf("read version %s; want 6", versionOf(read))
	}
	v, _ := strconv.ParseInt(read.Version.String(), 10, 64)
	put := func(ifVersion int64) *httptest.ResponseRecorder {
		return m.call(t, http.MethodPut, notesPath+"/c-1", "civitai_cleo",
			fmt.Sprintf(`{"data":{"text":"EDIT-%d"},"ifVersion":%d}`, ifVersion, ifVersion))
	}
	if rec := put(v); rec.Code != 200 {
		t.Fatalf("put with the read's version %d: %d %s", v, rec.Code, rec.Body)
	}
	// Read back before any poll: the acknowledgement's version, on the keyed get and the list.
	after := decodeKeyed(t, m.getKey(t, notesPath+"/c-1", "civitai_cleo").body)
	if versionOf(after) != "7" || string(after.Data) != `{"text":"EDIT-6"}` {
		t.Fatalf("keyed get after the put: version %s data %s; want 7, EDIT-6", versionOf(after), after.Data)
	}
	if got := versionsOf(decodeList(t, m.get(t, notesPath, "civitai_cleo").body)); got != "c-1=7" {
		t.Fatalf("list after the put: %s; want c-1=7", got)
	}
	rec := put(v)
	var refusal struct {
		Error string `json:"error"`
	}
	_ = json.Unmarshal(rec.Body.Bytes(), &refusal)
	if rec.Code != http.StatusConflict || refusal.Error != "version_conflict" {
		t.Fatalf("put with the stale version %d: %d %s; want 409 version_conflict", v, rec.Code, rec.Body)
	}
	// And the version the read-back answered writes again.
	nv, _ := strconv.ParseInt(after.Version.String(), 10, 64)
	if rec := put(nv); rec.Code != 200 {
		t.Fatalf("put with the read-back version %d: %d %s", nv, rec.Code, rec.Body)
	}
}
