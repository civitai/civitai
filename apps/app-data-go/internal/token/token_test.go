package token

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// hub is a fake token endpoint: it records each request and answers with the next status and
// a token numbered by call.
type hub struct {
	mu       sync.Mutex
	srv      *httptest.Server
	requests []*http.Request
	forms    []map[string][]string
	status   int
	expires  int
}

func newHub(t *testing.T) *hub {
	t.Helper()
	h := &hub{status: http.StatusOK, expires: 900}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		h.mu.Lock()
		h.requests = append(h.requests, r)
		h.forms = append(h.forms, r.PostForm)
		n, status, exp := len(h.requests), h.status, h.expires
		h.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		if status != http.StatusOK {
			_, _ = fmt.Fprint(w, `{"error":"invalid_client","error_description":"Client authentication failed"}`)
			return
		}
		_, _ = fmt.Fprintf(w, `{"access_token":"jwt-%d","token_type":"Bearer","expires_in":%d}`, n, exp)
	}))
	t.Cleanup(h.srv.Close)
	return h
}

func (h *hub) calls() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.requests)
}

const (
	clientID = "6f2a9c1e-4b7d-4e3a-8c5f-1d0e2b3a4c5d"
	secret   = "s3cr3t+value/with=chars"
)

func source(h *hub, cfg Config) (*Source, *time.Time) {
	now := time.Date(2031, 1, 2, 3, 4, 5, 0, time.UTC)
	cfg.URL = h.srv.URL
	if cfg.ClientID == "" {
		cfg.ClientID, cfg.ClientSecret = clientID, secret
	}
	s := New(cfg, nil)
	s.Now = func() time.Time { return now }
	return s, &now
}

func TestFetchSendsTheClientCredentialsGrant(t *testing.T) {
	h := newHub(t)
	s, _ := source(h, Config{Resource: "https://registry.invalid", Scope: "AppsRead"})
	tok, err := s.Token(context.Background())
	if err != nil || tok != "jwt-1" {
		t.Fatalf("Token = %q, %v; want jwt-1", tok, err)
	}
	r, form := h.requests[0], h.forms[0]
	if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
		t.Fatalf("request %s %q", r.Method, r.Header.Get("Content-Type"))
	}
	id, sec, ok := r.BasicAuth()
	// Form-encoded before Basic encoding (RFC 6749 §2.3.1).
	if !ok || id != clientID || sec != "s3cr3t%2Bvalue%2Fwith%3Dchars" {
		t.Fatalf("basic auth %q %q %v", id, sec, ok)
	}
	want := map[string]string{"grant_type": "client_credentials", "resource": "https://registry.invalid", "scope": "AppsRead"}
	for k, v := range want {
		if got := form[k]; len(got) != 1 || got[0] != v {
			t.Fatalf("form %s = %v, want %q", k, got, v)
		}
	}
	if len(form) != len(want) {
		t.Fatalf("form = %v, want exactly %v (the secret never in the body)", form, want)
	}
}

func TestNoResourceOrScopeWhenUnset(t *testing.T) {
	h := newHub(t)
	s, _ := source(h, Config{})
	if _, err := s.Token(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f := h.forms[0]; len(f) != 1 || f["grant_type"][0] != "client_credentials" {
		t.Fatalf("form = %v, want grant_type only", f)
	}
}

func TestTokenIsKeptUntilNearExpiryThenRefetched(t *testing.T) {
	h := newHub(t)
	s, now := source(h, Config{})
	ctx := context.Background()
	for range 3 {
		if tok, _ := s.Token(ctx); tok != "jwt-1" {
			t.Fatalf("Token = %q, want the kept jwt-1", tok)
		}
	}
	// 900 s token, replaced 30 s before it expires.
	*now = now.Add(869 * time.Second)
	if tok, _ := s.Token(ctx); tok != "jwt-1" || h.calls() != 1 {
		t.Fatalf("at 869s: %q after %d calls, want jwt-1 after 1", tok, h.calls())
	}
	*now = now.Add(time.Second)
	if tok, _ := s.Token(ctx); tok != "jwt-2" || h.calls() != 2 {
		t.Fatalf("at 870s: %q after %d calls, want jwt-2 after 2", tok, h.calls())
	}
}

func TestInvalidateFetchesANewToken(t *testing.T) {
	h := newHub(t)
	s, _ := source(h, Config{})
	ctx := context.Background()
	if tok, _ := s.Token(ctx); tok != "jwt-1" {
		t.Fatal(tok)
	}
	s.Invalidate()
	if tok, _ := s.Token(ctx); tok != "jwt-2" {
		t.Fatalf("after Invalidate: %q, want jwt-2", tok)
	}
}

func TestAShortTokenIsNotKept(t *testing.T) {
	h := newHub(t)
	h.expires = 20
	s, _ := source(h, Config{})
	ctx := context.Background()
	a, _ := s.Token(ctx)
	b, _ := s.Token(ctx)
	if a != "jwt-1" || b != "jwt-2" {
		t.Fatalf("tokens %q %q, want a fresh one each time", a, b)
	}
}

func TestRefusalIsAnErrorWithoutSecretsAndIsReported(t *testing.T) {
	h := newHub(t)
	h.status = http.StatusUnauthorized
	s, _ := source(h, Config{})
	var reported []error
	s.OnFetch = func(err error) { reported = append(reported, err) }
	tok, err := s.Token(context.Background())
	if err == nil || tok != "" {
		t.Fatalf("Token = %q, %v; want an error", tok, err)
	}
	if got := err.Error(); got != "token endpoint answered HTTP 401 (error invalid_client)" {
		t.Fatalf("error %q", got)
	}
	if strings.Contains(err.Error(), "s3cr3t") || strings.Contains(err.Error(), clientID) {
		t.Fatalf("error leaks a credential: %q", err)
	}
	// The endpoint recovers: the next call fetches, and both outcomes were reported.
	h.mu.Lock()
	h.status = http.StatusOK
	h.mu.Unlock()
	if tok, err := s.Token(context.Background()); err != nil || tok != "jwt-2" {
		t.Fatalf("after recovery: %q %v", tok, err)
	}
	if len(reported) != 2 || reported[0] == nil || reported[1] != nil {
		t.Fatalf("reported %v, want [error, nil]", reported)
	}
}

func TestAnswerWithoutTokenIsAnError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"token_type":"Bearer"}`)
	}))
	t.Cleanup(srv.Close)
	s := New(Config{URL: srv.URL, ClientID: clientID, ClientSecret: secret}, nil)
	if _, err := s.Token(context.Background()); err == nil {
		t.Fatal("want an error for an answer with no access_token")
	}
}

// A refusal is the hub's answer about this client (a 4xx but 429): ErrRefused, outcome `refused`. A
// 429, a 5xx or an unreachable hub is not: outcome `unavailable`. The error text stays the one it was.
func TestARefusalIsTellableFromAFailure(t *testing.T) {
	for status, want := range map[int]string{400: "refused", 401: "refused", 403: "refused", 429: "unavailable", 500: "unavailable", 503: "unavailable"} {
		h := newHub(t)
		h.status = status
		s, _ := source(h, Config{ClientID: clientID, ClientSecret: secret})
		var seen error
		s.OnFetch = func(err error) { seen = err }
		_, err := s.Token(context.Background())
		if got := Outcome(err); got != want || Outcome(seen) != want || errors.Is(err, ErrRefused) != (want == "refused") {
			t.Errorf("HTTP %d: outcome %q (OnFetch %q), ErrRefused %v; want %q", status, got, Outcome(seen), errors.Is(err, ErrRefused), want)
		}
		if !strings.Contains(err.Error(), fmt.Sprintf("HTTP %d (error invalid_client)", status)) {
			t.Errorf("HTTP %d: error text %q", status, err)
		}
	}
	h := newHub(t)
	s, _ := source(h, Config{ClientID: clientID, ClientSecret: secret})
	h.srv.Close()
	if _, err := s.Token(context.Background()); Outcome(err) != "unavailable" || errors.Is(err, ErrRefused) {
		t.Errorf("unreachable: %v, outcome %q", err, Outcome(err))
	}
	if Outcome(nil) != "ok" {
		t.Error("nil is not ok")
	}
}
