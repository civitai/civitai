package exchange

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
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

// A redirect is never followed: a 307 would re-send the form, the user's token in it, to Location.
func TestExchangeNeverFollowsARedirect(t *testing.T) {
	var reached atomic.Int32
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached.Add(1)
		_, _ = io.WriteString(w, `{"access_token":"x","expires_in":900}`)
	}))
	t.Cleanup(elsewhere.Close)
	for _, hc := range []*http.Client{nil, {Timeout: 5 * time.Second}} {
		e := hub(t, func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, elsewhere.URL+"/token", http.StatusTemporaryRedirect)
		})
		e.HTTP = hc
		_, err := e.Exchange(context.Background(), "civitai_user-token")
		if err == nil || errors.Is(err, ErrRefused) || !strings.Contains(err.Error(), "HTTP 307") {
			t.Fatalf("got %v, want a non-refusal failure naming the 307", err)
		}
	}
	if n := reached.Load(); n != 0 {
		t.Fatalf("🔴 the redirect target was reached %d times", n)
	}
}

// A 429 holds every exchange back for at least the wait the hub named: no call reaches the hub
// before it, a user's or a block token's, and the first one after it does.
func TestExchangeWaitsOutA429BeforeAskingTheHubAgain(t *testing.T) {
	cases := []struct {
		name   string
		header string
		body   string
		wait   time.Duration
	}{
		{"Retry-After seconds", "30", `{"error":"rate_limited"}`, 30 * time.Second},
		{"the meta's retryAfterSeconds", "", `{"error":"rate_limited","rateLimit":{"retryAfterSeconds":45,"retryAt":"2023-11-14T22:14:05.000Z"}}`, 45 * time.Second},
		{"retry_after", "", `{"error":"rate_limited","retry_after":20}`, 20 * time.Second},
		{"the longest of header and meta", "10", `{"error":"rate_limited","retry_after":10,"rateLimit":{"retryAfterSeconds":40}}`, 40 * time.Second},
		{"an HTTP-date", "Tue, 14 Nov 2023 22:14:50 GMT", `{}`, 30 * time.Second},
		{"no wait named", "", `{"error":"rate_limited"}`, minRateLimitHold},
		{"a wait past the cap", "86400", `{}`, maxRateLimitHold},
		{"an HTTP-date past the cap", "Wed, 15 Nov 2023 22:14:20 GMT", `{}`, maxRateLimitHold},
		{"seconds past the duration range", "1000000000000", `{}`, maxRateLimitHold},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			e := hub(t, func(w http.ResponseWriter, _ *http.Request) {
				if calls.Add(1) == 1 {
					if tc.header != "" {
						w.Header().Set("Retry-After", tc.header)
					}
					w.WriteHeader(http.StatusTooManyRequests)
					_, _ = io.WriteString(w, tc.body)
					return
				}
				_, _ = io.WriteString(w, `{"access_token":"eyJexchanged","expires_in":900}`)
			})
			// 2023-11-14T22:14:20Z, so the HTTP-date case names a wait of 30 s.
			now := time.Unix(1_700_000_060, 0)
			e.Now = func() time.Time { return now }

			_, err := e.ExchangeBlock(context.Background(), "a.b.c")
			var rl *RateLimitedError
			if !errors.As(err, &rl) || errors.Is(err, ErrRefused) || rl.RetryAfter != tc.wait {
				t.Fatalf("first exchange: got %v, want a non-refusal RateLimitedError of %s", err, tc.wait)
			}
			// Just inside the wait: neither exchange reaches the hub.
			now = now.Add(tc.wait - time.Second/2)
			for _, call := range []func(context.Context, string) (Token, error){e.Exchange, e.ExchangeBlock} {
				_, err = call(context.Background(), "civitai_user-token")
				if !errors.As(err, &rl) || rl.RetryAfter != time.Second/2 {
					t.Fatalf("inside the wait: got %v, want a RateLimitedError of 500ms", err)
				}
			}
			if n := calls.Load(); n != 1 {
				t.Fatalf("🔴 the hub was asked %d times inside the wait, want 1", n)
			}
			// Once the wait has passed, the hub is asked again.
			now = now.Add(time.Second / 2)
			if tok, err := e.Exchange(context.Background(), "civitai_user-token"); err != nil || tok.Access != "eyJexchanged" {
				t.Fatalf("after the wait: %+v %v", tok, err)
			}
			if n := calls.Load(); n != 2 {
				t.Fatalf("the hub was asked %d times, want 2", n)
			}
		})
	}
}
