package writes

import (
	"net/http"
	"strings"
	"sync"
	"testing"

	"github.com/civitai/civitai/apps/app-data-go/internal/session"
)

// READ-YOUR-WRITES: what each site answer hands to Acked. Every case's slug, collection, key, seq,
// record id and body are distinct.

type acked struct {
	token, schema string
	a             session.Ack
}

type ackLog struct {
	mu  sync.Mutex
	got []acked
}

func (l *ackLog) add(token, schema string, a session.Ack) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.got = append(l.got, acked{token, schema, a})
}

func (l *ackLog) take() []acked {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := l.got
	l.got = nil
	return out
}

// Each acknowledged create, put and delete reaches Acked with the writing token, the stream's schema
// (the named major, else 1) and what the store answered; nothing else does.
func TestEachAcknowledgedWriteIsHandedToAcked(t *testing.T) {
	log := &ackLog{}
	r := newRig(t, func(f *Forwarder) { f.Acked = log.add })
	const tok = "civitai_ack-writer"
	cases := []struct {
		name   string
		in     call
		status int
		answer string
		want   []acked
	}{
		{"create", call{method: "POST", path: "/v1/apps/ack-app-one/collections/kv/records", body: []byte(`{"data":{"n":1}}`)},
			201, `{"key":"01JMINTED","data":{"n":1},"version":1,"seq":71,"recordId":"rid-71"}`,
			[]acked{{tok, "urn:schema:apps.civitai.com:ack-app-one/kv@v1", session.Ack{Key: "01JMINTED", Seq: 71,
				URN: "urn:apps.civitai.com:ack-app-one/kv/rid-71", Body: []byte(`{"n":1}`)}}}},
		{"put at a named major", call{method: "PUT", path: "/v1/apps/ack-app-two/collections/runs/records/run-7?major=3", body: []byte(`{"data":{"n":2}}`)},
			200, `{"key":"run-7","data": {"n":2} ,"version":4,"seq":72,"recordId":"rid-72"}`,
			[]acked{{tok, "urn:schema:apps.civitai.com:ack-app-two/runs@v3", session.Ack{Key: "run-7", Seq: 72,
				URN: "urn:apps.civitai.com:ack-app-two/runs/rid-72", Body: []byte(`{"n":2}`)}}}},
		{"put with no record id", call{method: "PUT", path: "/v1/apps/ack-app-three/collections/kv/records/old-row", body: []byte(`{"data":{"n":3}}`)},
			200, `{"key":"old-row","data":{"n":3},"version":9,"seq":73,"recordId":null}`,
			[]acked{{tok, "urn:schema:apps.civitai.com:ack-app-three/kv@v1", session.Ack{Key: "old-row", Seq: 73, Body: []byte(`{"n":3}`)}}}},
		{"delete", call{method: "DELETE", path: "/v1/apps/ack-app-four/collections/kv/records/gone-1"},
			200, `{"deleted":true,"seq":74}`,
			[]acked{{tok, "urn:schema:apps.civitai.com:ack-app-four/kv@v1", session.Ack{Key: "gone-1", Seq: 74, Deleted: true}}}},
		{"delete that deleted nothing", call{method: "DELETE", path: "/v1/apps/ack-app-five/collections/kv/records/never-1"},
			200, `{"deleted":false}`, nil},
		{"delete answered deleted:false with a seq", call{method: "DELETE", path: "/v1/apps/ack-app-five/collections/kv/records/never-2"},
			200, `{"deleted":false,"seq":75}`, nil},
		{"put without a seq (a site before the store answered one)", call{method: "PUT", path: "/v1/apps/ack-app-six/collections/kv/records/k-6", body: []byte(`{"data":{"n":6}}`)},
			200, `{"key":"k-6","data":{"n":6},"version":2}`, nil},
		{"put answering another key", call{method: "PUT", path: "/v1/apps/ack-app-seven/collections/kv/records/k-7", body: []byte(`{"data":{"n":7}}`)},
			200, `{"key":"k-other","data":{"n":7},"seq":77}`, nil},
		{"put answering null data", call{method: "PUT", path: "/v1/apps/ack-app-eight/collections/kv/records/k-8", body: []byte(`{"data":{"n":8}}`)},
			200, `{"key":"k-8","data":null,"seq":78}`, nil},
		{"create answering a bad key", call{method: "POST", path: "/v1/apps/ack-app-nine/collections/kv/records", body: []byte(`{"data":{"n":9}}`)},
			201, `{"key":"a/b","data":{"n":9},"seq":79}`, nil},
		{"an answer that is not JSON", call{method: "PUT", path: "/v1/apps/ack-app-ten/collections/kv/records/k-10", body: []byte(`{"data":{"n":10}}`)},
			200, `not json`, nil},
		{"a refused put", call{method: "PUT", path: "/v1/apps/ack-app-eleven/collections/kv/records/k-11", body: []byte(`{"data":{"n":11}}`)},
			409, `{"code":"version_conflict","seq":81}`, nil},
		{"info", call{method: "GET", path: "/v1/apps/ack-app-thirteen/info"},
			200, `{"seq":83,"key":"k-13","data":{}}`, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r.site.set(answerWith(c.status, c.answer, map[string]string{"Content-Type": "application/json"}))
			c.in.auth = "Bearer " + tok
			if rec := r.do(t, c.in); rec.Code != c.status {
				t.Fatalf("%d %s", rec.Code, rec.Body)
			}
			got := log.take()
			if len(got) != len(c.want) {
				t.Fatalf("acked %+v, want %+v", got, c.want)
			}
			for i, w := range c.want {
				g := got[i]
				if g.token != w.token || g.schema != w.schema || g.a.Key != w.a.Key || g.a.Seq != w.a.Seq ||
					g.a.Deleted != w.a.Deleted || g.a.URN != w.a.URN || string(g.a.Body) != string(w.a.Body) {
					t.Fatalf("acked %+v (body %s), want %+v (body %s)", g, g.a.Body, w, w.a.Body)
				}
			}
		})
	}
}

// A lost answer acknowledges nothing (its outcome is unknown), and with no Acked set a write is
// forwarded and answered as before.
func TestNothingIsAcknowledgedWithoutAKnownAnswer(t *testing.T) {
	log := &ackLog{}
	r := newRig(t, func(f *Forwarder) { f.Acked = log.add })
	r.site.set(answerWith(http.StatusBadGateway, `{"key":"k-lost","data":{"n":1},"seq":90}`, nil))
	rec := r.do(t, call{method: "PUT", path: "/v1/apps/ack-lost/collections/kv/records/k-lost", auth: "Bearer civitai_lost", body: []byte(`{"data":{"n":1}}`)})
	if rec.Code != http.StatusGatewayTimeout || len(log.take()) != 0 {
		t.Fatalf("%d %s; want 504 and no ack", rec.Code, rec.Body)
	}
	plain := newRig(t)
	plain.site.set(answerWith(200, `{"key":"k-plain","data":{"n":2},"seq":91}`, nil))
	rec = plain.do(t, call{method: "PUT", path: "/v1/apps/ack-plain/collections/kv/records/k-plain", auth: "Bearer civitai_plain", body: []byte(`{"data":{"n":2}}`)})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"seq":91`) {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
}
