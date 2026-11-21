package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/superjson"
	"github.com/civitai/civitai/apps/feed-go/internal/trpc"
)

// devalueTestValue holds one object at two places and an undefined member: the dedup and the -1 a
// devalue answer writes, and the annotation a superjson one writes.
func devalueTestValue() any {
	shared := superjson.Object{{Key: "id", Val: int64(7)}}
	return superjson.Object{{Key: "items", Val: []any{shared, shared}}, {Key: "nextCursor", Val: superjson.Undefined{}}}
}

// nodeDevalueBody is what the Node app writes for devalueTestValue with TRPC_WRITE_DEVALUE=true, as
// node printed it (`JSON.stringify({result: {data: devalue.stringify(v)}})`, devalue from the repo).
const nodeDevalueBody = `{"result":{"data":"[{\"items\":1,\"nextCursor\":-1},[2,2],{\"id\":3},7]"}}`

// encodingAnswer is a computeFn that answers v as the real computes do: cache policy first, then
// computed.encode in the request's context.
func encodingAnswer(v any, ttl *trpc.CacheTTL) func(context.Context, *http.Request) (*computed, error) {
	return func(ctx context.Context, _ *http.Request) (*computed, error) {
		c := &computed{value: v, ttl: ttl}
		if err := c.encode(ctx); err != nil {
			return nil, err
		}
		return c, nil
	}
}

// superjsonBody is the body this service wrote for v before devalue existed: the superjson envelope in
// tRPC's.
func superjsonBody(t *testing.T, v any) string {
	t.Helper()
	b, err := superjson.Serialize(v)
	if err != nil {
		t.Fatal(err)
	}
	return `{"result":{"data":` + string(b) + `}}`
}

func capableRequest() *http.Request {
	r := publicRequest()
	r.Header.Set("x-client", "web")
	r.Header.Set("x-client-version", "5.1.537")
	return r
}

// With TRPC_WRITE_DEVALUE on, a capable web client's private answer is Node's devalue body, byte for
// byte, with the private Cache-Control (a devalue body must never reach a shared cache).
func TestServeWritesDevalueForACapableClient(t *testing.T) {
	fb := &proxyRecorder{}
	s := serveServer(prometheus.NewRegistry(), encodingAnswer(devalueTestValue(), nil), fb)
	s.WriteDevalue = true
	w := httptest.NewRecorder()
	s.ServeHTTP(w, capableRequest())
	if w.Code != http.StatusOK || fb.calls != 0 {
		t.Fatalf("code=%d proxied=%d, want 200 and 0", w.Code, fb.calls)
	}
	if got := w.Body.String(); got != nodeDevalueBody {
		t.Fatalf("body\n got  %s\n want %s", got, nodeDevalueBody)
	}
	if got := w.Header().Get("Cache-Control"); got != "max-age=0, private, no-cache" {
		t.Fatalf("Cache-Control = %q, want the private default", got)
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := servedBy(w); len(got) != 1 || got[0] != "go" {
		t.Fatalf("X-Feed-Go-Served = %q", got)
	}
}

// Every other combination is today's superjson body, byte for byte: the switch off, a client that
// cannot read devalue, or an edge-cacheable answer (a cached body is served to any client).
func TestServeWritesSuperjsonUnlessAllConditionsHold(t *testing.T) {
	v := devalueTestValue()
	want := superjsonBody(t, v)
	incapable := func() *http.Request {
		r := capableRequest()
		r.Header.Set("x-client-version", "5.0.2079")
		return r
	}
	sdk := func() *http.Request {
		r := capableRequest()
		r.Header.Del("x-client")
		return r
	}
	for name, c := range map[string]struct {
		on  bool
		ttl *trpc.CacheTTL
		req func() *http.Request
	}{
		"switch off, capable client":            {false, nil, capableRequest},
		"switch off, signed out":                {false, &trpc.SignedOutTTL, capableRequest},
		"switch on, bundle older than 5.0.2080": {true, nil, incapable},
		"switch on, not the web bundle":         {true, nil, sdk},
		"switch on, no client headers":          {true, nil, publicRequest},
		"switch on, edge-cacheable answer":      {true, &trpc.SignedOutTTL, capableRequest},
	} {
		t.Run(name, func(t *testing.T) {
			s := serveServer(prometheus.NewRegistry(), encodingAnswer(v, c.ttl), &proxyRecorder{})
			s.WriteDevalue = c.on
			w := httptest.NewRecorder()
			s.ServeHTTP(w, c.req())
			if got := w.Body.String(); got != want {
				t.Fatalf("body\n got  %s\n want %s", got, want)
			}
			if wantCC := trpc.ResultCacheControl(c.ttl); w.Header().Get("Cache-Control") != wantCC {
				t.Fatalf("Cache-Control = %q, want %q", w.Header().Get("Cache-Control"), wantCC)
			}
		})
	}
}

// A request handed to the Node app is the app's answer: with the switch on and a capable client, the
// proxied bytes and status are passed through untouched, devalue or not.
func TestServeFallbackIsUntouchedWithDevalueOn(t *testing.T) {
	node := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(nodeDevalueBody))
	})
	s := serveServer(prometheus.NewRegistry(), func(context.Context, *http.Request) (*computed, error) {
		return nil, fallback.New("unported-filter")
	}, node)
	s.WriteDevalue = true
	w := httptest.NewRecorder()
	s.ServeHTTP(w, capableRequest())
	if w.Code != http.StatusAccepted || w.Body.String() != nodeDevalueBody {
		t.Fatalf("code=%d body=%s, want the app's 202 and its bytes", w.Code, w.Body.String())
	}
	if got := servedBy(w); len(got) != 1 || got[0] != "node" {
		t.Fatalf("X-Feed-Go-Served = %q", got)
	}
}

// The shadow comparison reads the superjson envelope the Node sampler sends whatever the app wrote,
// so a sample is computed as superjson with the switch on, even when it carries a capable client's
// headers: it still matches.
func TestShadowCompareStaysSuperjsonWithDevalueOn(t *testing.T) {
	reg := prometheus.NewRegistry()
	var made *computed
	value := superjson.Object{{Key: "items", Val: []any{superjson.Object{{Key: "postId", Val: int64(7)}}}}, {Key: "nextCursor", Val: nil}}
	s := serveServer(reg, func(ctx context.Context, r *http.Request) (*computed, error) {
		c, err := encodingAnswer(value, nil)(ctx, r)
		made = c
		return c, err
	}, nil)
	s.WriteDevalue = true
	s.compare(context.Background(), EndpointAsPosts, ShadowRequest{
		Input:   `{}`,
		Headers: map[string]string{"x-client": "web", "x-client-version": "5.1.537"},
		Node:    json.RawMessage(nodeEnvelope),
	})
	if made == nil || made.devalue {
		t.Fatalf("the sample was computed as %+v, want superjson", made)
	}
	if shadowResult(t, reg, "match") != 1 {
		t.Fatal("the sample did not match Node's envelope")
	}
}

// A value devalue refuses is written as superjson for that answer (the app's
// writeSerializeWithFallback); the answer is still served.
func TestEncodeFallsBackToSuperjson(t *testing.T) {
	v := superjson.Object{{Key: "m", Val: json.RawMessage(`{not json`)}}
	c := &computed{value: v}
	if err := c.encode(trpc.WithDevalueWrite(context.Background())); err != nil {
		t.Fatal(err)
	}
	if c.devalue || c.dbuf != nil || c.buf == nil {
		t.Fatalf("devalue=%v dbuf=%v buf=%v, want a pooled superjson payload", c.devalue, c.dbuf, c.buf)
	}
	if got := string(c.payload); got != `{"json":{"m":{not json}}` {
		t.Fatalf("payload = %s", got)
	}
	c.release()
	if c.payload != nil || c.buf != nil {
		t.Fatal("not released")
	}
}

// A devalue payload is pooled like a superjson one and released with the answer.
func TestDevalueAnswerIsReleased(t *testing.T) {
	var made *computed
	s := serveServer(prometheus.NewRegistry(), func(ctx context.Context, r *http.Request) (*computed, error) {
		c, err := encodingAnswer(devalueTestValue(), nil)(ctx, r)
		made = c
		return c, err
	}, &proxyRecorder{})
	s.WriteDevalue = true
	w := httptest.NewRecorder()
	s.ServeHTTP(w, capableRequest())
	if w.Body.String() != nodeDevalueBody {
		t.Fatalf("body = %s", w.Body.String())
	}
	if made == nil || !made.devalue || made.dbuf != nil || made.payload != nil {
		t.Fatalf("answer %+v: want a devalue answer, released after writing", made)
	}
}
