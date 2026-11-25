package writes

import (
	"net/http"
	"testing"
)

// THE `@me` ROUTES (viewer-keyed collections): forwarded to the site's own `@me` paths, the key
// never named here; acknowledged at the key the site's answer names. Every case's slug, collection,
// parent, seq and body are distinct.
// Fails on origin/main: there is no `@me` route (PUT …/records/@me is the {key} route there, which
// refuses `@me` as a key, 400 invalid record key).
func TestTheViewersOwnDocumentRoutesAreForwarded(t *testing.T) {
	log := &ackLog{}
	r := newRig(t, func(f *Forwarder) { f.Acked = log.add })
	const tok = "civitai_mine-writer"
	cases := []struct {
		name, method, path, sentPath, sentQuery string
		body                                    []byte
		answer                                  string
		ackKey                                  string
		ackSeq                                  int64
		deleted                                 bool
	}{
		{"put @me", "PUT", "/v1/apps/mine-app-one/collections/likes/records/@me", "/api/internal/blocks/storage/likes/@me",
			"from=mine-app-one", []byte(`{"data":{"v":1}}`), `{"key":"abcdefghijklmnopqrstuvwxyz","data":{"v":1},"version":1,"seq":301,"recordId":"rid-301"}`,
			"abcdefghijklmnopqrstuvwxyz", 301, false},
		{"put @me/parent at a major", "PUT", "/v1/apps/mine-app-two/collections/votes/records/@me/01JREC.7?major=2", "/api/internal/blocks/storage/votes/@me/01JREC.7",
			"from=mine-app-two&major=2", []byte(`{"data":{"v":-1}}`), `{"key":"01JREC.7:bcdefghijklmnopqrstuvwxyz2","data":{"v":-1},"version":3,"seq":302}`,
			"01JREC.7:bcdefghijklmnopqrstuvwxyz2", 302, false},
		{"delete @me/parent", "DELETE", "/v1/apps/mine-app-three/collections/votes/records/@me/rec-3?ifVersion=4", "/api/internal/blocks/storage/votes/@me/rec-3",
			"from=mine-app-three&ifVersion=4", nil, `{"deleted":true,"seq":303,"key":"rec-3:cdefghijklmnopqrstuvwxyz23"}`,
			"rec-3:cdefghijklmnopqrstuvwxyz23", 303, true},
		{"delete @me answered without its key (a site before it named one)", "DELETE", "/v1/apps/mine-app-four/collections/likes/records/@me",
			"/api/internal/blocks/storage/likes/@me", "from=mine-app-four", nil, `{"deleted":true,"seq":304}`, "", 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			before := len(r.site.requests())
			r.site.set(answerWith(200, c.answer, map[string]string{"Content-Type": "application/json"}))
			rec := r.do(t, call{method: c.method, path: c.path, auth: "Bearer " + tok, body: c.body})
			if rec.Code != 200 || rec.Body.String() != c.answer {
				t.Fatalf("%d %s", rec.Code, rec.Body)
			}
			got := r.site.requests()
			if len(got) != before+1 {
				t.Fatalf("%d requests sent, want 1", len(got)-before)
			}
			if s := got[len(got)-1]; s.method != c.method || s.path != c.sentPath || s.query != c.sentQuery || string(s.body) != string(c.body) {
				t.Fatalf("sent %s %s?%s %s", s.method, s.path, s.query, s.body)
			}
			acks := log.take()
			if c.ackKey == "" {
				if len(acks) != 0 {
					t.Fatalf("acked %+v, want none", acks)
				}
				return
			}
			if len(acks) != 1 || acks[0].a.Key != c.ackKey || acks[0].a.Seq != c.ackSeq || acks[0].a.Deleted != c.deleted || acks[0].token != tok {
				t.Fatalf("acked %+v", acks)
			}
		})
	}
	// A put ack carries the version and timestamps the site answered (the shared overlay shows them).
	r.site.set(answerWith(200, `{"key":"defghijklmnopqrstuvwxyz234","data":{"v":5},"version":7,"seq":305,"createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-02T00:00:00.000Z"}`, nil))
	if rec := r.do(t, call{method: "PUT", path: "/v1/apps/mine-app-five/collections/likes/records/@me", auth: "Bearer " + tok, body: []byte(`{"data":{"v":5}}`)}); rec.Code != 200 {
		t.Fatalf("%d", rec.Code)
	}
	if a := log.take(); len(a) != 1 || a[0].a.Version != 7 || a[0].a.CreatedAt != "2026-11-01T00:00:00.000Z" || a[0].a.UpdatedAt != "2026-11-02T00:00:00.000Z" {
		t.Fatalf("acked %+v", a)
	}
}

// A malformed parent is refused here, nothing sent; the `@me/{parent}` path has its preflight.
func TestAMalformedParentIsRefusedHere(t *testing.T) {
	r := newRig(t)
	for _, parent := range []string{"a:b", "...", "x%2Fy", "p@q"} {
		rec := r.do(t, call{method: "PUT", path: "/v1/apps/mine-app-six/collections/votes/records/@me/" + parent, auth: "Bearer civitai_p", body: []byte(`{"data":{}}`)})
		if e := decode(t, rec); rec.Code != http.StatusBadRequest || e.Code != "invalid_request" {
			t.Errorf("parent %q: %d %s", parent, rec.Code, rec.Body)
		}
	}
	long := make([]byte, 97)
	for i := range long {
		long[i] = 'a'
	}
	if rec := r.do(t, call{method: "DELETE", path: "/v1/apps/mine-app-six/collections/votes/records/@me/" + string(long), auth: "Bearer civitai_p"}); rec.Code != http.StatusBadRequest {
		t.Errorf("a 97-character parent: %d", rec.Code)
	}
	if n := len(r.site.requests()); n != 0 {
		t.Fatalf("🔴 %d requests sent", n)
	}
	if rec := r.do(t, call{method: "OPTIONS", path: "/v1/apps/mine-app-six/collections/votes/records/@me/rec-1"}); rec.Code != 204 ||
		rec.Header().Get("Access-Control-Allow-Methods") != AllowMethods {
		t.Fatalf("preflight: %d %v", rec.Code, rec.Header())
	}
}
