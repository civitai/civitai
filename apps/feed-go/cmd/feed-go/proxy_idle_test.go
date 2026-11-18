package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// Scaled-down timeouts: the upstream's keep-alive, the proxy idle timeout under test (below it), and
// the pause between two requests (past the keep-alive, far below DefaultTransport's 90 s). Each is
// several times the one before it, so a slow CI runner (a late idle timer, a slow first request)
// does not change which side of a timeout a request lands on.
const (
	testUpstreamKeepAlive = 300 * time.Millisecond
	testProxyIdle         = 50 * time.Millisecond
	testPause             = time.Second
)

// These tests are not parallel, and no other test in this package may close an httptest.Server
// while one of them pauses: httptest.Server.Close closes http.DefaultTransport's idle connections, so
// a proxy that fell back to DefaultTransport (the regression these tests catch) would lose its stale
// connection to another test's Close and pass. TestFallbackProxyTransport catches that regression
// without timing.

type connKey struct{}

// keepAliveUpstream models a Node server whose keep-alive timeout is keepAlive, at the moment the race
// is lost: a request that arrives on a connection idle longer than keepAlive is one Node had already
// closed, so the upstream closes the connection without answering. (A real Node server closes it at
// the timeout; the client only fails when its request crosses that close in flight. Closing at the
// request makes the crossing deterministic.)
type keepAliveUpstream struct {
	keepAlive time.Duration
	srv       *httptest.Server

	mu        sync.Mutex
	idleSince map[net.Conn]time.Time
	conns     int // connections opened
	dropped   int // requests dropped for arriving on a connection past its keep-alive
	answered  int
	received  []string // method and body of each answered request
}

func newKeepAliveUpstream(t *testing.T, keepAlive time.Duration) *keepAliveUpstream {
	t.Helper()
	u := &keepAliveUpstream{keepAlive: keepAlive, idleSince: map[net.Conn]time.Time{}}
	u.srv = httptest.NewUnstartedServer(http.HandlerFunc(u.serve))
	u.srv.Config.ConnContext = func(ctx context.Context, c net.Conn) context.Context {
		return context.WithValue(ctx, connKey{}, c)
	}
	u.srv.Config.ConnState = func(c net.Conn, s http.ConnState) {
		u.mu.Lock()
		defer u.mu.Unlock()
		switch s {
		case http.StateNew:
			u.conns++
		case http.StateIdle:
			u.idleSince[c] = time.Now()
		case http.StateHijacked, http.StateClosed:
			delete(u.idleSince, c)
		}
	}
	u.srv.Start()
	t.Cleanup(u.srv.Close)
	return u
}

func (u *keepAliveUpstream) serve(w http.ResponseWriter, r *http.Request) {
	c := r.Context().Value(connKey{}).(net.Conn)
	u.mu.Lock()
	since, reused := u.idleSince[c]
	stale := reused && time.Since(since) > u.keepAlive
	if stale {
		u.dropped++
	} else {
		u.answered++
	}
	u.mu.Unlock()
	if stale {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err != nil {
			panic(err)
		}
		_ = conn.Close()
		return
	}
	body, _ := io.ReadAll(r.Body)
	u.mu.Lock()
	u.received = append(u.received, r.Method+" "+string(body))
	u.mu.Unlock()
	w.WriteHeader(http.StatusOK)
}

func (u *keepAliveUpstream) counts() (conns, dropped, answered int) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.conns, u.dropped, u.answered
}

func (u *keepAliveUpstream) answeredRequests() []string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]string(nil), u.received...)
}

func (u *keepAliveUpstream) target(t *testing.T) *url.URL {
	t.Helper()
	target, err := url.Parse(u.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return target
}

type proxyErrors struct {
	mu      sync.Mutex
	reasons []string
}

func (e *proxyErrors) record(_ *http.Request, reason string, _ error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.reasons = append(e.reasons, reason)
}

func (e *proxyErrors) got() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return append([]string(nil), e.reasons...)
}

func proxyDo(p http.Handler, method, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), method, "http://green.example.test/api/trpc/x", strings.NewReader(body))
	w := httptest.NewRecorder()
	p.ServeHTTP(w, req)
	return w
}

// A POST sent after the upstream's keep-alive has expired, and long before DefaultTransport's 90 s
// idle timeout, goes out on a new connection and is answered: the proxy dropped its idle connection
// at its own, shorter idle timeout. With DefaultTransport it would be written onto the connection the
// upstream had closed and answered 502 (TestKeepAliveUpstreamDropsAStaleConnection).
func TestFallbackProxyPostAfterTheUpstreamKeepAlive(t *testing.T) {
	up := newKeepAliveUpstream(t, testUpstreamKeepAlive)
	errs := &proxyErrors{}
	p := fallbackProxy(up.target(t), testProxyIdle, errs.record, nil)

	if w := proxyDo(p, http.MethodPost, "first"); w.Code != http.StatusOK {
		t.Fatalf("first POST: status %d, want 200", w.Code)
	}
	time.Sleep(testPause)
	if w := proxyDo(p, http.MethodPost, "second"); w.Code != http.StatusOK {
		t.Fatalf("POST after the upstream keep-alive: status %d, want 200 "+
			"(the proxy reused a connection the upstream had closed)", w.Code)
	}
	if got := up.answeredRequests(); len(got) != 2 || got[0] != "POST first" || got[1] != "POST second" {
		t.Errorf("upstream answered %q, want [\"POST first\" \"POST second\"]", got)
	}
	if conns, dropped, answered := up.counts(); conns != 2 || dropped != 0 || answered != 2 {
		t.Errorf("upstream saw %d connections, %d dropped and %d answered requests; want 2, 0, 2", conns, dropped, answered)
	}
	if got := errs.got(); len(got) != 0 {
		t.Errorf("proxy errors %v, want none", got)
	}
}

// Positive control for the upstream above: a proxy that keeps idle connections longer than the
// upstream's keep-alive (as DefaultTransport's 90 s does) writes the second POST onto the stale
// connection, cannot replay it, and answers 502, reported as an upstream error. A GET in the same
// position is replayed on a new connection by the transport and is answered.
func TestKeepAliveUpstreamDropsAStaleConnection(t *testing.T) {
	up := newKeepAliveUpstream(t, testUpstreamKeepAlive)
	errs := &proxyErrors{}
	p := fallbackProxy(up.target(t), time.Hour, errs.record, nil)

	if w := proxyDo(p, http.MethodPost, "first"); w.Code != http.StatusOK {
		t.Fatalf("first POST: status %d, want 200", w.Code)
	}
	time.Sleep(testPause)
	if w := proxyDo(p, http.MethodPost, "second"); w.Code != http.StatusBadGateway {
		t.Fatalf("POST on the stale connection: status %d, want 502 (the harness did not reproduce the failure)", w.Code)
	}
	if got := errs.got(); len(got) != 1 || got[0] != proxyErrorUpstream {
		t.Errorf("proxy errors %v, want [%s]", got, proxyErrorUpstream)
	}

	if w := proxyDo(p, http.MethodGet, ""); w.Code != http.StatusOK {
		t.Fatalf("GET on a new connection: status %d, want 200", w.Code)
	}
	time.Sleep(testPause)
	if w := proxyDo(p, http.MethodGet, ""); w.Code != http.StatusOK {
		t.Fatalf("GET on the stale connection: status %d, want 200 (replayed on a new connection)", w.Code)
	}
	if got := up.answeredRequests(); len(got) != 3 || got[0] != "POST first" || got[1] != "GET " || got[2] != "GET " {
		t.Errorf("upstream answered %q, want [\"POST first\" \"GET \" \"GET \"]", got)
	}
	// Connections: the first POST's, the first GET's, and the replayed GET's.
	if conns, dropped, answered := up.counts(); conns != 3 || dropped != 2 || answered != 3 {
		t.Errorf("upstream saw %d connections, %d dropped and %d answered requests; want 3, 2, 3", conns, dropped, answered)
	}
}

// A client that has left before the Node app answers is reported as canceled, not as an upstream error.
func TestFallbackProxyReportsACanceledClient(t *testing.T) {
	up := newKeepAliveUpstream(t, testUpstreamKeepAlive)
	errs := &proxyErrors{}
	p := fallbackProxy(up.target(t), testProxyIdle, errs.record, nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	req := httptest.NewRequestWithContext(ctx, http.MethodPost, "http://green.example.test/api/trpc/x", strings.NewReader("x"))
	w := httptest.NewRecorder()
	p.ServeHTTP(w, req)
	if w.Code != http.StatusBadGateway {
		t.Errorf("status %d, want 502", w.Code)
	}
	if got := errs.got(); len(got) != 1 || got[0] != proxyErrorCanceled {
		t.Errorf("proxy errors %v, want [%s]", got, proxyErrorCanceled)
	}
}

// The production transport: idle connections are dropped after 3 s, below the Node app's keep-alive
// (Node's 5 s default unless its server is configured longer), and the one upstream keeps more than
// DefaultTransport's 2 idle connections.
func TestFallbackProxyTransport(t *testing.T) {
	target, err := url.Parse("http://127.0.0.1:1")
	if err != nil {
		t.Fatal(err)
	}
	tr, ok := fallbackProxy(target, fallbackIdleTimeout, nil, nil).Transport.(*http.Transport)
	if !ok {
		t.Fatal("the proxy has no *http.Transport of its own")
	}
	if tr == http.DefaultTransport {
		t.Fatal("the proxy shares http.DefaultTransport")
	}
	if tr.IdleConnTimeout != 3*time.Second {
		t.Errorf("IdleConnTimeout = %v, want 3s", tr.IdleConnTimeout)
	}
	if tr.MaxIdleConnsPerHost != 32 {
		t.Errorf("MaxIdleConnsPerHost = %d, want 32", tr.MaxIdleConnsPerHost)
	}
	if fallbackProxy(target, 7*time.Second, nil, nil).Transport.(*http.Transport).IdleConnTimeout != 7*time.Second {
		t.Error("the idle parameter does not reach the transport")
	}
}
