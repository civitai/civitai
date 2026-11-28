package beacon

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/civitai/civitai/apps/beacon-go/internal/auth"
	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// FuzzCompute: request parsing (body decode, content type, JSON, the schemas, the referer / origin
// host, the client-ip chain) never panics on any request, and every answer is one the Node handler
// can give: 200 with at most one row for the endpoint's table, or a 400 with one of its four bodies;
// anything else (an OPTIONS preflight, a conditional request, ...) is a fallback with a reason.
func FuzzCompute(f *testing.F) {
	f.Add(true, "POST", "https://a.test/models/1", "a.test", "", "192.0.2.1", `{"path":"/models/1","duration":5}`)
	f.Add(false, "POST", "https://a.test", "a.test", "application/json", "192.0.2.1", `{"type":"ImageView","entityType":"Image","entityId":1,"details":{"1":2}}`)
	f.Add(true, "OPTIONS", "", "a.test", "", "", "")
	f.Add(false, "POST", "https://A.TEST:443/x", "a.test", "text/plain; charset=utf-8", "2001:db8::1", `"{}"`)
	f.Add(true, "POST", "https://a.test/", "a.test", "application/json", "", `"{\"path\":\"/\"}"`)
	f.Fuzz(func(t *testing.T, ping bool, method, source, host, contentType, ip, body string) {
		headers := map[string]string{"host": host, "referer": source, "origin": source}
		if contentType != "" {
			headers["content-type"] = contentType
		}
		if ip != "" {
			headers["x-forwarded-for"] = ip
		}
		r := &Request{
			Method:  method,
			Headers: headers,
			Body:    []byte(body),
			HTTP:    httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", nil),
		}
		e := &Engine{Sessions: fixedUser{u: &auth.SessionUser{ID: 3}}, TrackerEnabled: true}
		endpoint, table := EndpointPulse, TableViews
		if ping {
			endpoint, table = EndpointPing, TablePageViews
		}
		out, err := e.Compute(context.Background(), endpoint, r)
		if err != nil {
			if fallback.Reason(err) == "" {
				t.Fatalf("a non-fallback error: %v", err)
			}
			return
		}
		switch out.Response.Status {
		case 200:
			if out.Response.Body != "" || len(out.Writes) > 1 {
				t.Fatalf("200 with body %q and %d writes", out.Response.Body, len(out.Writes))
			}
			for _, w := range out.Writes {
				v, err := jsvalue.Parse(string(w.Body))
				if w.Table != table || err != nil || !v.IsPlainObject() {
					t.Fatalf("row %s %q: %v", w.Table, w.Body, err)
				}
			}
		case 400:
			switch out.Response.Body {
			case "invalid request", "invalid body", "invalid input", "Invalid JSON":
			default:
				t.Fatalf("400 body %q", out.Response.Body)
			}
			if len(out.Writes) != 0 {
				t.Fatal("a 400 wrote")
			}
		default:
			t.Fatalf("status %d", out.Response.Status)
		}
	})
}

// FuzzURLHost: urlHostOf never panics, and a host it answers is lowercase, holds no character the
// URL parser would strip or encode, and keeps a port only when it is not the scheme's default.
func FuzzURLHost(f *testing.F) {
	for _, s := range []string{"https://a.test/x", "http://A.test:80", "https://a.test:0443", "x", "https://", "https://a.test:99999"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		host, res := urlHostOf(s)
		if res != urlHost {
			if host != "" {
				t.Fatalf("%q: host %q without a urlHost result", s, host)
			}
			return
		}
		if host == "" || host != strings.ToLower(host) || strings.ContainsAny(host, "/?#@[]%\\ ") {
			t.Fatalf("%q: host %q", s, host)
		}
		if strings.HasSuffix(host, ":443") && strings.HasPrefix(strings.ToLower(s), "https:") {
			t.Fatalf("%q: default port kept: %q", s, host)
		}
		if strings.HasSuffix(host, ":80") && strings.HasPrefix(strings.ToLower(s), "http:") {
			t.Fatalf("%q: default port kept: %q", s, host)
		}
	})
}

// FuzzTrackBatch: /api/track/batch never panics on any body, and every answer is one the Node handler
// can give: 200 with one row per event (at most TRACK_BATCH_MAX, each to `search` or `actions`), a
// 400 with one of its bodies and no row, or a fallback with a reason (the whole batch left to Node).
func FuzzTrackBatch(f *testing.F) {
	f.Add("application/json", `[{"kind":"search","data":{"query":" q ","index":"i","filters":{"a":1}}}]`)
	f.Add("application/json", `[{"kind":"action","data":{"type":"LoginRedirect","reason":"image-gen"}},{"kind":"impression","data":{}}]`)
	f.Add("", `[{"kind":"action","data":{"type":"App_Session","details":{"appBlockId":"a","host":"page","durationMs":1,"submits":2,"messagesToHost":3}}}]`)
	f.Add("application/json", `"[{\"kind\":\"action\",\"data\":{\"type\":\"AwardBounty_Click\"}}]"`)
	f.Add("text/plain", `[{"kind":"action","data":{"type":"Membership_Cancel","details":{"__proto__":1,"reason":"r","from":"f","9":0}}}]`)
	f.Fuzz(func(t *testing.T, contentType, body string) {
		headers := map[string]string{"host": "a.test", "origin": "https://a.test", "cf-connecting-ip": "192.0.2.1"}
		if contentType != "" {
			headers["content-type"] = contentType
		}
		r := &Request{
			Method:  "POST",
			Headers: headers,
			Body:    []byte(body),
			HTTP:    httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/", nil),
		}
		e := &Engine{Sessions: fixedUser{u: &auth.SessionUser{ID: 3}}, TrackerEnabled: true}
		out, err := e.Compute(context.Background(), EndpointTrackBatch, r)
		if err != nil {
			if fallback.Reason(err) == "" {
				t.Fatalf("a non-fallback error: %v", err)
			}
			if len(out.Writes) != 0 {
				t.Fatal("a fallback wrote")
			}
			return
		}
		switch out.Response.Status {
		case 200:
			if out.Response.Body != "" || len(out.Writes) == 0 || len(out.Writes) > TrackBatchMax {
				t.Fatalf("200 with body %q and %d writes", out.Response.Body, len(out.Writes))
			}
			for _, w := range out.Writes {
				v, err := jsvalue.Parse(string(w.Body))
				if (w.Table != TableSearch && w.Table != TableActions) || err != nil || !v.IsPlainObject() {
					t.Fatalf("row %s %q: %v", w.Table, w.Body, err)
				}
				if id, ok := v.O.Get("userId"); !ok || id.N != 3 {
					t.Fatalf("row %s without the session's userId", w.Body)
				}
			}
		case 400:
			switch out.Response.Body {
			case "invalid request", "invalid body", "invalid input", "Invalid JSON":
			default:
				t.Fatalf("400 body %q", out.Response.Body)
			}
			if len(out.Writes) != 0 {
				t.Fatal("a 400 wrote")
			}
		default:
			t.Fatalf("status %d", out.Response.Status)
		}
	})
}
