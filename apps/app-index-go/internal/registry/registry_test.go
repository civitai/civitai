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

func TestNextRejectsMalformedEvents(t *testing.T) {
	for name, body := range map[string]string{
		"upsert without entity": "event: upsert\ndata: {\"cursor\":\"\"}\n\n",
		"delete without urn":    "event: delete\ndata: {\"cursor\":\"c\"}\n\n",
		"bad json":              "event: live\ndata: {\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			_, err := streamOf(body).Next()
			if CodeOf(err) != Unavailable {
				t.Fatalf("got %v, want unavailable", err)
			}
		})
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

func TestIdleStreamEnds(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: live\ndata: {\"cursor\":\"c1\"}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer srv.Close()
	defer close(release)
	s, err := (&Client{BaseURL: srv.URL, IdleTimeout: 100 * time.Millisecond}).Subscribe(context.Background(), Request{Schema: "s"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if ev, err := s.Next(); err != nil || ev.Type != Live {
		t.Fatalf("got %+v %v", ev, err)
	}
	start := time.Now()
	_, err = s.Next()
	var pe *Error
	if !errors.As(err, &pe) || pe.Code != Unavailable || pe.Message != "stream idle" {
		t.Fatalf("got %v, want unavailable: stream idle", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("idle detection took %s", time.Since(start))
	}
}

func TestHeartbeatsKeepAStreamAlive(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for range 6 {
			_, _ = io.WriteString(w, ": heartbeat\n\n")
			w.(http.Flusher).Flush()
			time.Sleep(40 * time.Millisecond)
		}
		_, _ = io.WriteString(w, "event: live\ndata: {\"cursor\":\"c1\"}\n\n")
	}))
	defer srv.Close()
	s, err := (&Client{BaseURL: srv.URL, IdleTimeout: 150 * time.Millisecond}).Subscribe(context.Background(), Request{Schema: "s"})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if ev, err := s.Next(); err != nil || ev.Type != Live {
		t.Fatalf("got %+v %v: heartbeats did not count as traffic", ev, err)
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
			if ev.Type == Delete && ev.URN == "" {
				t.Fatal("delete without urn")
			}
		}
		t.Fatal("stream never ended")
	})
}
