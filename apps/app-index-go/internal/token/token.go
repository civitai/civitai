// Package token gets the index's own access token from the auth hub with the OAuth client
// credentials grant (RFC 6749 §4.4), so the index subscribes as itself rather than anonymously.
//
// A token is fetched when first needed and kept until shortly before it expires, or until the
// consumer reports that the registry refused it (Invalidate), whichever comes first. Errors never
// carry the client secret or a token.
package token

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Config names the token endpoint and the client.
type Config struct {
	// URL is the hub's token endpoint.
	URL string
	// ClientID and ClientSecret authenticate the index as an OAuth client (HTTP Basic).
	ClientID, ClientSecret string
	// Resource, when set, is sent as the RFC 8707 `resource` the token is for.
	Resource string
	// Scope, when set, is sent as `scope`.
	Scope string
}

// Margin is how long before its expiry a token is replaced, so a subscription never opens with a
// token about to run out.
const Margin = 30 * time.Second

// RequestTimeout bounds one call to the token endpoint.
const RequestTimeout = 10 * time.Second

// Source hands out the index's access token.
type Source struct {
	cfg  Config
	http *http.Client
	// Now is the clock; nil is time.Now.
	Now func() time.Time
	// OnFetch, when set, is called after each call to the token endpoint with its error (nil: a
	// token was fetched).
	OnFetch func(err error)

	mu    sync.Mutex
	tok   string
	until time.Time
}

// New is a Source for cfg. hc nil is a client with RequestTimeout.
func New(cfg Config, hc *http.Client) *Source {
	if hc == nil {
		hc = &http.Client{Timeout: RequestTimeout}
	}
	return &Source{cfg: cfg, http: hc}
}

func (s *Source) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Token is a token valid for at least Margin more, fetching one when the kept one is missing,
// near its expiry, or was invalidated.
func (s *Source) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tok != "" && s.now().Before(s.until) {
		return s.tok, nil
	}
	tok, life, err := s.fetch(ctx)
	if s.OnFetch != nil {
		s.OnFetch(err)
	}
	if err != nil {
		return "", err
	}
	s.tok, s.until = tok, s.now().Add(life-Margin)
	return tok, nil
}

// Invalidate drops the kept token: the next Token fetches a new one.
func (s *Source) Invalidate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tok, s.until = "", time.Time{}
}

// fetch calls the token endpoint once.
func (s *Source) fetch(ctx context.Context) (string, time.Duration, error) {
	form := url.Values{"grant_type": {"client_credentials"}}
	if s.cfg.Resource != "" {
		form.Set("resource", s.cfg.Resource)
	}
	if s.cfg.Scope != "" {
		form.Set("scope", s.cfg.Scope)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.cfg.URL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", 0, errors.New("token request could not be built")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	// RFC 6749 §2.3.1: the id and secret are form-encoded before Basic encoding.
	req.SetBasicAuth(url.QueryEscape(s.cfg.ClientID), url.QueryEscape(s.cfg.ClientSecret))
	res, err := s.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", 0, ctx.Err()
		}
		// The error text names the URL only; it is still not echoed.
		return "", 0, errors.New("token endpoint unreachable")
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	var body struct {
		AccessToken string  `json:"access_token"`
		ExpiresIn   float64 `json:"expires_in"`
		Error       string  `json:"error"`
	}
	_ = json.Unmarshal(raw, &body)
	if res.StatusCode/100 != 2 {
		code := body.Error
		if code == "" || len(code) > 64 || strings.ContainsAny(code, " \n\"") {
			code = "none"
		}
		return "", 0, fmt.Errorf("token endpoint answered HTTP %d (error %s)", res.StatusCode, code)
	}
	if body.AccessToken == "" {
		return "", 0, errors.New("token endpoint answered without an access_token")
	}
	life := time.Duration(body.ExpiresIn * float64(time.Second))
	if life <= Margin {
		// Too short to keep: use it for this subscription only.
		life = Margin
	}
	return body.AccessToken, life, nil
}
