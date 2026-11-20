package registry

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func streamOf(s string) *Stream {
	return newStream(io.NopCloser(strings.NewReader(s)), func() {})
}

func TestNextReadsEveryEventType(t *testing.T) {
	s := streamOf("" +
		": heartbeat\n\n" +
		"event: upsert\nid:\ndata: {\"entity\":{\"urn\":\"urn:apps.civitai.com:app/a\",\"schemas\":[\"s\"],\"rev\":\"r1\",\"body\":{\"slug\":\"a\"}},\"cursor\":\"\"}\n\n" +
		"event: delete\r\nid: c2\r\ndata: {\"urn\":\"urn:apps.civitai.com:app/b\",\"cursor\":\"c2\"}\r\n\r\n" +
		"event: live\nid: c3\ndata: {\"cursor\":\"c3\"}\n\n" +
		"event: progress\nid: c4\ndata: {\"cursor\":\"c4\"}\n\n" +
		"event: end\ndata: {}\n\n")
	want := []Event{
		{Type: Upsert, Entity: Entity{URN: "urn:apps.civitai.com:app/a", Schemas: []string{"s"}, Rev: "r1", Body: []byte(`{"slug":"a"}`)}},
		{Type: Delete, URN: "urn:apps.civitai.com:app/b", Cursor: "c2"},
		{Type: Live, Cursor: "c3"},
		{Type: Progress, Cursor: "c4"},
		{Type: End},
	}
	for i, w := range want {
		got, err := s.Next()
		if err != nil {
			t.Fatalf("event %d: %v", i, err)
		}
		if got.Type != w.Type || got.URN != w.URN || got.Cursor != w.Cursor || got.Entity.URN != w.Entity.URN ||
			got.Entity.Rev != w.Entity.Rev || string(got.Entity.Body) != string(w.Entity.Body) {
			t.Fatalf("event %d = %+v, want %+v", i, got, w)
		}
	}
	if _, err := s.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("after end: %v, want io.EOF", err)
	}
}

func TestNextJoinsMultiLineData(t *testing.T) {
	s := streamOf("event: live\ndata: {\"cursor\":\ndata: \"c9\"}\n\n")
	ev, err := s.Next()
	if err != nil || ev.Type != Live || ev.Cursor != "c9" {
		t.Fatalf("got %+v, %v", ev, err)
	}
}

func TestNextSkipsUnknownEvents(t *testing.T) {
	s := streamOf("event: brand-new\ndata: {\"x\":1}\n\ndata: no event name\n\nevent: live\ndata: {\"cursor\":\"c1\"}\n\n")
	ev, err := s.Next()
	if err != nil || ev.Type != Live || ev.Cursor != "c1" {
		t.Fatalf("got %+v, %v", ev, err)
	}
}

func TestNextErrorEvent(t *testing.T) {
	s := streamOf("event: error\ndata: {\"error\":\"slow_consumer\",\"message\":\"behind\"}\n\n")
	_, err := s.Next()
	if CodeOf(err) != SlowConsumer {
		t.Fatalf("got %v, want slow_consumer", err)
	}
	s = streamOf("event: error\ndata: not json\n\n")
	if _, err := s.Next(); CodeOf(err) != Unavailable {
		t.Fatalf("unnamed error: got %v, want unavailable", err)
	}
}

func TestNextClosedWithoutEndIsUnavailable(t *testing.T) {
	s := streamOf("event: live\ndata: {\"cursor\":\"c1\"}\n\n")
	if _, err := s.Next(); err != nil {
		t.Fatal(err)
	}
	_, err := s.Next()
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != Unavailable || pe.Message != "stream closed" {
		t.Fatalf("got %v, want unavailable: stream closed", err)
	}
}

// An event of a known type that cannot be decoded is returned as Malformed, with the cursor it
// carried when one could be read, and the stream goes on.
func TestNextReturnsMalformedEvents(t *testing.T) {
	cases := []struct {
		name, raw string
		want      Event
	}{
		{"upsert without entity", "event: upsert\ndata: {\"cursor\":\"\"}\n\n",
			Event{Type: Malformed, Of: Upsert}},
		{"upsert without urn, with a cursor", "event: upsert\ndata: {\"entity\":{\"rev\":\"r\"},\"cursor\":\"c7\"}\n\n",
			Event{Type: Malformed, Of: Upsert, Cursor: "c7"}},
		{"delete without urn", "event: delete\nid: c8\ndata: {\"cursor\":\"c8\"}\n\n",
			Event{Type: Malformed, Of: Delete, Cursor: "c8"}},
		{"data not JSON, cursor from the SSE id", "event: delete\nid: c9\ndata: {nope\n\n",
			Event{Type: Malformed, Of: Delete, Cursor: "c9"}},
		{"data not JSON, no id", "event: live\ndata: {\n\n",
			Event{Type: Malformed, Of: Live}},
		{"cursor not a string", "event: progress\ndata: {\"cursor\":5}\n\n",
			Event{Type: Malformed, Of: Progress}},
		{"delete with a urn but a numeric cursor", "event: delete\ndata: {\"urn\":\"u\",\"cursor\":5}\n\n",
			Event{Type: Malformed, Of: Delete}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := streamOf(tc.raw + "event: live\ndata: {\"cursor\":\"next\"}\n\n")
			got, err := s.Next()
			if err != nil {
				t.Fatalf("err %v: a malformed event ended the stream", err)
			}
			if got.Type != tc.want.Type || got.Of != tc.want.Of || got.Cursor != tc.want.Cursor || got.Reason == "" {
				t.Fatalf("got %+v, want %+v with a reason", got, tc.want)
			}
			if strings.Contains(got.Reason, "nope") || strings.Contains(got.Reason, "rev") {
				t.Fatalf("reason %q carries event data", got.Reason)
			}
			if ev, err := s.Next(); err != nil || ev.Type != Live || ev.Cursor != "next" {
				t.Fatalf("after the malformed event: %+v %v", ev, err)
			}
		})
	}
}

// An upsert whose URN was read but whose entity has a field of the wrong type is kept, bodiless,
// so the consumer treats it as deleted.
func TestNextUpsertWithBadFieldKeepsItsURN(t *testing.T) {
	s := streamOf("event: upsert\ndata: {\"entity\":{\"urn\":\"urn:x:a\",\"schemas\":5,\"body\":{\"slug\":\"a\"}},\"cursor\":\"c3\"}\n\n")
	ev, err := s.Next()
	if err != nil || ev.Type != Upsert || ev.Entity.URN != "urn:x:a" || ev.Entity.Body != nil || ev.Cursor != "c3" {
		t.Fatalf("got %+v %v", ev, err)
	}
}

// A field of the wrong type that is not the one a delete needs keeps the delete; on any other
// event it is Malformed, with the cursor.
func TestNextWrongTypedFields(t *testing.T) {
	ev, err := streamOf("event: delete\ndata: {\"urn\":\"urn:x:b\",\"entity\":5,\"cursor\":\"c4\"}\n\n").Next()
	if err != nil || ev.Type != Delete || ev.URN != "urn:x:b" || ev.Cursor != "c4" {
		t.Fatalf("delete: %+v %v", ev, err)
	}
	ev, err = streamOf("event: live\ndata: {\"entity\":5,\"cursor\":\"c5\"}\n\n").Next()
	if err != nil || ev.Type != Malformed || ev.Of != Live || ev.Cursor != "c5" {
		t.Fatalf("live: %+v %v", ev, err)
	}
}

func TestErrorText(t *testing.T) {
	if got := (&Error{Code: SlowConsumer}).Error(); got != "slow_consumer" {
		t.Fatalf("%q", got)
	}
	if got := (&Error{Code: BadRequest, Message: "no schema"}).Error(); got != "bad_request: no schema" {
		t.Fatalf("%q", got)
	}
	if CodeOf(errors.New("dial tcp: refused")) != Unavailable {
		t.Fatal("a non-protocol error is unavailable")
	}
}

func TestSubscribeRefusesBadURLAndHonoursCancel(t *testing.T) {
	if _, err := (&Client{BaseURL: "http://bad host.invalid"}).Subscribe(context.Background(), Request{Schema: "s"}); CodeOf(err) != BadRequest {
		t.Fatalf("bad url: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	if _, err := (&Client{BaseURL: srv.URL}).Subscribe(ctx, Request{Schema: "s"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: %v", err)
	}
}

func TestEndIgnoresItsData(t *testing.T) {
	if ev, err := streamOf("event: end\ndata: {oops\n\n").Next(); err != nil || ev.Type != End {
		t.Fatalf("got %+v %v", ev, err)
	}
}

func TestNextLineTooLong(t *testing.T) {
	s := streamOf("event: live\ndata: " + strings.Repeat("x", MaxLine+10) + "\n\n")
	_, err := s.Next()
	var pe *Error
	if !errors.As(err, &pe) || pe.Message != "line too long" {
		t.Fatalf("got %v, want line too long", err)
	}
}

func TestSubscribeSendsRequest(t *testing.T) {
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: end\ndata: {}\n\n")
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL + "/reg/", Token: "tok", UserAgent: "ua"}
	s, err := c.Subscribe(context.Background(), Request{Schema: "urn:schema:x:app@v1", Cursor: "c 1"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if ev, err := s.Next(); err != nil || ev.Type != End {
		t.Fatalf("got %+v %v", ev, err)
	}
	if got.URL.Path != "/reg/subscribe" || got.URL.Query().Get("schema") != "urn:schema:x:app@v1" || got.URL.Query().Get("cursor") != "c 1" {
		t.Fatalf("request %s", got.URL)
	}
	if got.Header.Get("Authorization") != "Bearer tok" || got.Header.Get("Accept") != "text/event-stream" || got.Header.Get("User-Agent") != "ua" {
		t.Fatalf("headers %v", got.Header)
	}
}

func TestSubscribeWithoutCursorOrTokenSendsNeither(t *testing.T) {
	var got *http.Request
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		w.Header().Set("Content-Type", "text/event-stream")
	}))
	defer srv.Close()
	s, err := (&Client{BaseURL: srv.URL}).Subscribe(context.Background(), Request{Schema: "s"})
	if err != nil {
		t.Fatal(err)
	}
	_ = s.Close()
	if got.URL.Query().Has("cursor") || got.Header.Get("Authorization") != "" {
		t.Fatalf("request %s %v", got.URL, got.Header)
	}
}

// A request's own token is sent in place of the client's, with or without one on the client.
func TestSubscribeRequestTokenReplacesTheClientToken(t *testing.T) {
	var got []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = append(got, r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "text/event-stream")
	}))
	defer srv.Close()
	for _, c := range []*Client{{BaseURL: srv.URL, Token: "static-1"}, {BaseURL: srv.URL}} {
		s, err := c.Subscribe(context.Background(), Request{Schema: "s", Token: "own-2"})
		if err != nil {
			t.Fatal(err)
		}
		_ = s.Close()
	}
	if len(got) != 2 || got[0] != "Bearer own-2" || got[1] != "Bearer own-2" {
		t.Fatalf("Authorization %q, want Bearer own-2 twice", got)
	}
}

func TestSubscribeErrorBeforeStream(t *testing.T) {
	cases := []struct {
		status int
		body   string
		want   Code
	}{
		{410, `{"error":"cursor_expired","message":"gone"}`, CursorExpired},
		{400, `{"error":"bad_request","message":"no"}`, BadRequest},
		{401, `{"error":"invalid_token"}`, InvalidToken},
		{503, `{"error":"unavailable"}`, Unavailable},
		{502, `<html>bad gateway</html>`, Unavailable},
	}
	for _, tc := range cases {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
			_, _ = io.WriteString(w, tc.body)
		}))
		_, err := (&Client{BaseURL: srv.URL}).Subscribe(context.Background(), Request{Schema: "s"})
		srv.Close()
		var pe *Error
		if !errors.As(err, &pe) || pe.Code != tc.want || pe.Status != tc.status {
			t.Fatalf("%d %s: got %v, want %s", tc.status, tc.body, err, tc.want)
		}
	}
}

func TestSubscribeRejectsNonEventStream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{}`)
	}))
	defer srv.Close()
	_, err := (&Client{BaseURL: srv.URL}).Subscribe(context.Background(), Request{Schema: "s"})
	if CodeOf(err) != Unavailable {
		t.Fatalf("got %v", err)
	}
}

func TestSubscribeConnectFailureIsUnavailable(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	_, err := (&Client{BaseURL: url}).Subscribe(context.Background(), Request{Schema: "s"})
	if CodeOf(err) != Unavailable {
		t.Fatalf("got %v", err)
	}
	if _, err := (&Client{BaseURL: url}).Subscribe(context.Background(), Request{}); CodeOf(err) != BadRequest {
		t.Fatalf("no schema: got %v", err)
	}
}

func TestNewHTTPClientHasNoQuietnessTimeouts(t *testing.T) {
	c := NewHTTPClient()
	tr, ok := c.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("transport %T", c.Transport)
	}
	if c.Timeout != 0 || tr.ResponseHeaderTimeout != 0 || tr.IdleConnTimeout != 0 {
		t.Fatalf("a quiet stream or slow header would be cut off: client %v header %v idle %v",
			c.Timeout, tr.ResponseHeaderTimeout, tr.IdleConnTimeout)
	}
	if tr.HTTP2 == nil || tr.HTTP2.SendPingTimeout != H2PingAfter || tr.HTTP2.PingTimeout != H2PingTimeout {
		t.Fatalf("HTTP/2 pings not configured: %+v", tr.HTTP2)
	}
	if tr.DialContext == nil || tr.TLSHandshakeTimeout != DialTimeout {
		t.Fatal("no dial timeout")
	}
}

// Headers that come late and a stream silent between events are not a lost connection.
func TestQuietStreamIsNotLost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(1500 * time.Millisecond) // headers late
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: live\ndata: {\"cursor\":\"c1\"}\n\n")
		w.(http.Flusher).Flush()
		time.Sleep(2 * time.Second) // silent: not even a heartbeat
		_, _ = io.WriteString(w, "event: progress\ndata: {\"cursor\":\"c2\"}\n\n")
	}))
	defer srv.Close()
	s, err := (&Client{BaseURL: srv.URL, HTTP: NewHTTPClient()}).Subscribe(context.Background(), Request{Schema: "s"})
	if err != nil {
		t.Fatalf("late headers: %v", err)
	}
	defer func() { _ = s.Close() }()
	for _, want := range []string{"c1", "c2"} {
		ev, err := s.Next()
		if err != nil || ev.Cursor != want {
			t.Fatalf("want %s, got %+v %v", want, ev, err)
		}
	}
}

// A connection that dies under an open stream ends the read at once, as unavailable.
func TestKilledConnectionIsDetected(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: live\ndata: {\"cursor\":\"c1\"}\n\n")
		w.(http.Flusher).Flush()
		conn, _, err := http.NewResponseController(w).Hijack()
		if err != nil {
			return
		}
		_ = conn.Close()
	}))
	defer srv.Close()
	s, err := (&Client{BaseURL: srv.URL, HTTP: NewHTTPClient()}).Subscribe(context.Background(), Request{Schema: "s"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if ev, err := s.Next(); err != nil || ev.Type != Live {
		t.Fatalf("got %+v %v", ev, err)
	}
	start := time.Now()
	_, err = s.Next()
	if CodeOf(err) != Unavailable || time.Since(start) > 5*time.Second {
		t.Fatalf("got %v after %s, want unavailable at once", err, time.Since(start))
	}
}

func FuzzNext(f *testing.F) {
	f.Add("event: upsert\ndata: {\"entity\":{\"urn\":\"u\"},\"cursor\":\"\"}\n\nevent: live\ndata: {\"cursor\":\"c\"}\n\n")
	f.Add("event: error\ndata: {\"error\":\"x\"}\n\n")
	f.Add(": c\r\n\r\nevent: end\r\n\r\n")
	f.Fuzz(func(t *testing.T, in string) {
		s := streamOf(in)
		for range len(in) + 2 {
			ev, err := s.Next()
			if err != nil {
				return
			}
			if ev.Type == Upsert && ev.Entity.URN == "" {
				t.Fatal("upsert without urn")
			}
			if ev.Type == Malformed && ev.Of == "" {
				t.Fatal("malformed event without its type")
			}
			if ev.Type == Delete && ev.URN == "" {
				t.Fatal("delete without urn")
			}
		}
		t.Fatal("stream never ended")
	})
}
