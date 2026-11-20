package exchange

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func hub(t *testing.T, h http.HandlerFunc) *Exchanger {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	now := time.Unix(1_700_000_000, 0)
	return &Exchanger{
		Config: Config{URL: srv.URL, ClientID: "relay client", ClientSecret: "s3cr&t", Resource: "https://apps.invalid"},
		Now:    func() time.Time { return now },
	}
}

func TestExchangeSendsAnRFC8693RequestAsTheRelayClient(t *testing.T) {
	var form url.Values
	var id, secret string
	e := hub(t, func(w http.ResponseWriter, r *http.Request) {
		id, secret, _ = r.BasicAuth()
		_ = r.ParseForm()
		form = r.PostForm
		_, _ = io.WriteString(w, `{"access_token":"eyJexchanged","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","expires_in":900}`)
	})
	tok, err := e.Exchange(context.Background(), "civitai_user-token")
	if err != nil {
		t.Fatal(err)
	}
	want := url.Values{
		"grant_type": {GrantType}, "subject_token": {"civitai_user-token"}, "subject_token_type": {AccessTokenType},
		"resource": {"https://apps.invalid"}, "scope": {"AppDataRead"},
	}
	if form.Encode() != want.Encode() {
		t.Fatalf("form %v", form)
	}
	// Basic credentials are form-encoded first (RFC 6749 §2.3.1).
	if id != "relay+client" || secret != "s3cr%26t" { //nolint:gosec // G101: a synthetic test fixture, not a credential
		t.Fatalf("basic %q %q", id, secret)
	}
	if tok.Access != "eyJexchanged" || !tok.Expires.Equal(time.Unix(1_700_000_900, 0)) {
		t.Fatalf("%+v", tok)
	}
}

func TestExchangeErrorsNeverCarryATokenOrTheSecret(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		body    string
		refused bool
	}{
		{"invalid_grant", 400, `{"error":"invalid_grant"}`, true},
		{"invalid_client", 401, `{"error":"invalid_client"}`, true},
		{"rate limited", 429, `{"error":"rate_limited"}`, false},
		{"server error", 500, `<html>civitai_user-token</html>`, false},
		{"no token", 200, `{"expires_in":900}`, false},
		{"no lifetime", 200, `{"access_token":"x"}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := hub(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			})
			_, err := e.Exchange(context.Background(), "civitai_user-token")
			if err == nil || errors.Is(err, ErrRefused) != tc.refused {
				t.Fatalf("got %v, refused want %v", err, tc.refused)
			}
			if strings.Contains(err.Error(), "civitai_user-token") || strings.Contains(err.Error(), "s3cr") {
				t.Fatalf("error carries a credential: %v", err)
			}
		})
	}
}

func TestExchangeTransportFailures(t *testing.T) {
	bad := &Exchanger{Config: Config{URL: "http://hub.invalid/\x7f"}}
	if _, err := bad.Exchange(context.Background(), "t"); err == nil || errors.Is(err, ErrRefused) {
		t.Fatalf("unbuildable request: %v", err)
	}
	e := &Exchanger{Config: Config{URL: "http://127.0.0.1:1"}}
	if _, err := e.Exchange(context.Background(), "t"); err == nil || errors.Is(err, ErrRefused) {
		t.Fatalf("unreachable: %v", err)
	}
	block := make(chan struct{})
	defer close(block)
	e = hub(t, func(_ http.ResponseWriter, r *http.Request) {
		select {
		case <-block:
		case <-r.Context().Done():
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := e.Exchange(ctx, "t"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("deadline: %v", err)
	}
}
