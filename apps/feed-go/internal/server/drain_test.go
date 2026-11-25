package server

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

// listen serves h on a fresh loopback port and returns the server and its base URL.
func listen(t *testing.T, h http.Handler) (*http.Server, string) {
	t.Helper()
	ln, err := (&net.ListenConfig{}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	s := &http.Server{Handler: h, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = s.Serve(ln) }()
	t.Cleanup(func() { _ = s.Close() })
	return s, "http://" + ln.Addr().String()
}

// get issues a GET on a NEW connection (no keep-alive reuse), so a closed listener shows as a
// dial error rather than being masked by a pooled connection.
func get(url string) (int, error) {
	c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return 0, err
	}
	_ = resp.Body.Close()
	return resp.StatusCode, nil
}

// TestDrainOrder pins the shutdown order on real listeners: /readyz fails FIRST while /healthz
// (liveness) stays 200 and the public listener still answers new requests; only after the wait does
// the public listener close (a new connection is refused).
func TestDrainOrder(t *testing.T) {
	s := muxServer()
	internal := InternalMux(s, okHandler(), false)
	public, publicURL := listen(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	_, internalURL := listen(t, internal)

	// Before: ready, live, serving.
	for path, want := range map[string]int{internalURL + "/readyz": 200, internalURL + "/healthz": 200, publicURL: 200} {
		if code, err := get(path); err != nil || code != want {
			t.Fatalf("before drain %s: %d %v, want %d", path, code, err, want)
		}
	}

	inWait, release := make(chan struct{}), make(chan struct{})
	var stopped bool
	var mu sync.Mutex
	done := make(chan struct{})
	go func() {
		defer close(done)
		Drain(&s.Readiness, func() {
			close(inWait)
			<-release
		}, func() {
			mu.Lock()
			stopped = true
			mu.Unlock()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = public.Shutdown(ctx)
		})
	}()
	<-inWait

	// During the wait: readiness fails, liveness does not, the public listener still serves.
	if code, err := get(internalURL + "/readyz"); err != nil || code != http.StatusServiceUnavailable {
		t.Fatalf("during wait /readyz: %d %v, want 503", code, err)
	}
	if code, err := get(internalURL + "/healthz"); err != nil || code != http.StatusOK {
		t.Fatalf("during wait /healthz: %d %v, want 200 (liveness must not fail while draining)", code, err)
	}
	for i := 0; i < 3; i++ {
		if code, err := get(publicURL); err != nil || code != http.StatusOK {
			t.Fatalf("during wait public request %d: %d %v, want 200 (listener must keep serving)", i, code, err)
		}
	}
	mu.Lock()
	if stopped {
		mu.Unlock()
		t.Fatal("stop ran before the wait returned")
	}
	mu.Unlock()

	close(release)
	<-done

	// After: the public listener is closed, so a new connection is refused.
	_, err := get(publicURL)
	var op *net.OpError
	if err == nil || !errors.As(err, &op) || op.Op != "dial" {
		t.Fatalf("after drain public request: err %v, want a refused dial", err)
	}
}

// A Server that has not started draining answers /readyz 200 (the zero value is ready).
func TestReadyzZeroValueIsReady(t *testing.T) {
	internal := InternalMux(muxServer(), okHandler(), false)
	if code := statusOf(internal, "/readyz"); code != http.StatusOK {
		t.Fatalf("/readyz before draining: %d, want 200", code)
	}
}
