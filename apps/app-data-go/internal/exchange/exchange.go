// Package exchange trades a user's hub access token for a short-lived token toward the registry
// adapter, at the hub's token endpoint (RFC 8693 token exchange), with this service's own
// confidential client. The hub lists that client as a RELAY of the adapter's resource, so the token
// it issues names the user (`sub`), the app the user's token was issued to (`client_id`), and this
// service (`act.sub`); the adapter serves private data only to a token whose `act.sub` it lists
// (`REGISTRY_ADAPTER_PRIVATE_RELAYS`). The auth extension's Relays rule 1: a relay never passes a
// consumer's token on, it exchanges it for one whose resource is the upstream.
//
// The hub only exchanges one of its ORIGINAL access tokens (apps/auth/src/lib/server/oauth/
// user-exchange.ts, step 5), never a token it already exchanged, and caps the result's life at 15
// minutes (EXCHANGED_TOKEN_MAX_TTL). Errors never carry a token or the client secret.
//
// With APP_DATA_BLOCK_EXCHANGE on, an App Block token is exchanged too, at the same endpoint as the
// same client, with the block-token subject type (apps/auth/src/lib/server/oauth/block-exchange.ts).
// The hub exchanges each block token once only, so those exchanges go through a BlockCache (block.go).
package exchange

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The RFC 8693 names the hub reads (apps/auth/src/lib/server/oauth/constants.ts).
const (
	GrantType       = "urn:ietf:params:oauth:grant-type:token-exchange"
	AccessTokenType = "urn:ietf:params:oauth:token-type:access_token" //nolint:gosec // G101: an RFC 8693 token-type name, not a credential
	// BlockTokenType is the subject type of an App Block token (apps/auth constants.ts BLOCK_TOKEN_TYPE).
	BlockTokenType = "urn:civitai:token-type:block-token" //nolint:gosec // G101: a token-type name, not a credential
)

// Config names the token endpoint, this service's client and the resource exchanged for.
type Config struct {
	URL                    string
	ClientID, ClientSecret string
	// Resource is the adapter's resource identifier: exactly one, as the hub requires.
	Resource string
}

// Scope is the one scope every exchange asks for: `AppDataRead`, all a private stream reads (the
// adapter's gate 4). Least privilege: without it the hub would issue the whole ceiling. The hub
// parses `scope` as space-separated TokenScope names (apps/auth scope.ts parseScopeRequest) and
// refuses a request outside the ceiling (`invalid_scope`) rather than narrowing it: the ceiling is
// the user's token's scope (the consent the user gave the app), within the resource's and the app's
// (token-exchange.ts exchangeScopeCeiling). So a user who never granted the app AppDataRead gets a
// refused exchange, and the read goes to REST.
const Scope = "AppDataRead"

// Token is an exchanged token and when it stops being valid.
type Token struct {
	Access  string
	Expires time.Time
}

// ErrRefused is the hub refusing the exchange (an expired, revoked or unknown subject token, an
// app or user the resource does not admit). The read then goes to REST, whose answer is the site's.
var ErrRefused = errors.New("exchange: the hub refused the exchange")

// RefusedError is a refusal with the hub's answer: its status and its OAuth error code (`none` when
// the hub sent none a log could carry). It is ErrRefused (errors.Is).
type RefusedError struct {
	Status int
	Code   string
	// Reason is set only on a block token refused here, before the hub (blockverify.go): which check
	// refused it, in the hub's words. Never a token or a claim value.
	Reason string
}

func (e *RefusedError) Error() string {
	return fmt.Sprintf("%s (HTTP %d, %s)", ErrRefused.Error(), e.Status, e.Code)
}

// Unwrap makes a RefusedError ErrRefused.
func (e *RefusedError) Unwrap() error { return ErrRefused }

// RefusalCodes are the OAuth error codes the hub refuses an exchange with (apps/auth
// block-exchange.ts and user-exchange.ts, the 400 and 401 answers), and `local`: a block token refused
// here, never sent (BlockVerifier). RefusalCode maps any other to `other`, so a metric label never holds
// what the hub happened to send.
var RefusalCodes = []string{
	"invalid_request", "invalid_client", "invalid_target", "unauthorized_client", "invalid_grant", "invalid_scope",
	LocalRefusalCode, "other",
}

// RefusalCode is err's refusal code, one of RefusalCodes; `none` when err is not a refusal.
func RefusalCode(err error) string {
	var re *RefusedError
	if !errors.As(err, &re) {
		return "none"
	}
	for _, c := range RefusalCodes {
		if c == re.Code {
			return c
		}
	}
	return "other"
}

// RateLimitedError is the hub answering 429. Not a refusal: the subject may be fine. Usually this
// client's exchange budget is spent (the hub's `token-exchange` limit, one budget per client for user
// and block exchanges alike, charged only for subjects the hub found), and RetryAfter is how long the
// Exchanger holds every exchange back. When the hub names its per-viewer limit on subjects it could not
// find (HubMissLimit), Scoped is set and nothing else is held back: that limit is keyed by this client
// and the viewer's address, so another viewer's exchange is not refused by it.
type RateLimitedError struct {
	RetryAfter time.Duration
	Scoped     bool
}

func (e *RateLimitedError) Error() string {
	return fmt.Sprintf("exchange: the token endpoint is rate limiting this client (retry in %s)", e.RetryAfter)
}

// After a 429 the Exchanger waits the hub's Retry-After (or the body's rateLimit.retryAfterSeconds
// or retry_after, whichever is longest) before it calls the hub again. An answer naming none is held
// minRateLimitHold; one naming more than maxRateLimitHold is held that long, so a broken header cannot
// stop the exchange for long: the hub's budget window is one minute.
const (
	minRateLimitHold = time.Second
	maxRateLimitHold = 2 * time.Minute
)

// HubMissLimit is the `rateLimit.id` of the hub's 429 for too many subjects it could not find from one
// client and viewer address (apps/auth oauth/rate-limit.ts `token-exchange-miss`). It never holds the
// Exchanger (RateLimitedError.Scoped).
const HubMissLimit = "oauth.token-exchange-miss"

// Exchanger calls the hub. Use it through a pointer: it holds the rate-limit hold.
type Exchanger struct {
	Config
	// HTTP is the client; nil is http.DefaultClient. Calls are bounded by their context.
	HTTP *http.Client
	// Now is the clock; nil is time.Now.
	Now func() time.Time

	mu sync.Mutex
	// heldUntil: no exchange calls the hub before it (the last 429's wait); zero is none.
	heldUntil time.Time
}

// held is how long the last 429 still holds exchanges back at now; zero once it has passed.
func (e *Exchanger) held(now time.Time) time.Duration {
	e.mu.Lock()
	defer e.mu.Unlock()
	if now.Before(e.heldUntil) {
		return e.heldUntil.Sub(now)
	}
	return 0
}

// hold holds exchanges back until until, never shortening a longer hold.
func (e *Exchanger) hold(until time.Time) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if until.After(e.heldUntil) {
		e.heldUntil = until
	}
}

// Exchange trades subject, a user's hub access token, for a token toward Resource.
func (e *Exchanger) Exchange(ctx context.Context, subject string) (Token, error) {
	return e.exchange(ctx, subject, AccessTokenType)
}

// ExchangeBlock trades subject, an App Block token, for a token toward Resource. The hub refuses a
// second exchange of the same block token: call it through a BlockCache, never directly.
func (e *Exchanger) ExchangeBlock(ctx context.Context, subject string) (Token, error) {
	return e.exchange(ctx, subject, BlockTokenType)
}

func (e *Exchanger) exchange(ctx context.Context, subject, subjectType string) (Token, error) {
	now := time.Now
	if e.Now != nil {
		now = e.Now
	}
	// Within a 429's wait the hub is not asked: every exchange shares this client's budget there.
	if wait := e.held(now()); wait > 0 {
		return Token{}, &RateLimitedError{RetryAfter: wait}
	}
	form := url.Values{
		"grant_type":         {GrantType},
		"subject_token":      {subject},
		"subject_token_type": {subjectType},
		"resource":           {e.Resource},
		"scope":              {Scope},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.URL, strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, errors.New("exchange: request could not be built")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	// The viewer's address as the edge named it (ClientIPHeader), so the hub keys its limit on subjects
	// it cannot find by viewer, not by this service. Only an address this service read from the edge.
	if ip := ClientIP(ctx); ip != "" {
		req.Header.Set("X-Forwarded-For", ip)
	}
	// RFC 6749 §2.3.1: the id and secret are form-encoded before Basic encoding.
	req.SetBasicAuth(url.QueryEscape(e.ClientID), url.QueryEscape(e.ClientSecret))
	hc := NoRedirects(e.HTTP)
	start := now()
	res, err := hc.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return Token{}, ctx.Err()
		}
		return Token{}, errors.New("exchange: token endpoint unreachable")
	}
	defer func() { _ = res.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	var body struct {
		AccessToken string  `json:"access_token"`
		ExpiresIn   float64 `json:"expires_in"`
		Error       string  `json:"error"`
		RetryAfter  float64 `json:"retry_after"`
		RateLimit   struct {
			RetryAfterSeconds float64 `json:"retryAfterSeconds"`
			ID                string  `json:"id"`
		} `json:"rateLimit"`
	}
	_ = json.Unmarshal(raw, &body)
	switch {
	case res.StatusCode == http.StatusTooManyRequests:
		// Measured from the answer, so the hold is never shorter than the wait the hub named.
		answered := now()
		wait := rateLimitWait(res.Header.Get("Retry-After"), answered, body.RateLimit.RetryAfterSeconds, body.RetryAfter)
		if body.RateLimit.ID == HubMissLimit {
			// One viewer's made-up subjects: that viewer's answer, never every viewer's.
			return Token{}, &RateLimitedError{RetryAfter: wait, Scoped: true}
		}
		e.hold(answered.Add(wait))
		return Token{}, &RateLimitedError{RetryAfter: wait}
	case res.StatusCode == http.StatusBadRequest || res.StatusCode == http.StatusUnauthorized:
		// invalid_grant, unauthorized_client, invalid_scope, invalid_client: a fact about this
		// subject or this client, not a transient failure.
		return Token{}, &RefusedError{Status: res.StatusCode, Code: safeCode(body.Error)}
	case res.StatusCode/100 != 2:
		return Token{}, fmt.Errorf("exchange: token endpoint answered HTTP %d (%s)", res.StatusCode, safeCode(body.Error))
	case body.AccessToken == "" || body.ExpiresIn <= 0:
		return Token{}, errors.New("exchange: answer without an access_token and its lifetime")
	}
	// Measured from before the call, so the expiry is never later than the hub's.
	return Token{Access: body.AccessToken, Expires: start.Add(time.Duration(body.ExpiresIn * float64(time.Second)))}, nil
}

// NoRedirects is a copy of hc (nil: the default client) that never follows a redirect: the 3xx is
// returned as the answer. A followed redirect would re-send the request, a 307 or 308 with its body
// (the user's token) and, to the same host, its credentials, wherever the Location points.
func NoRedirects(hc *http.Client) *http.Client {
	c := http.Client{}
	if hc != nil {
		c = *hc
	}
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &c
}

// rateLimitWait is how long a 429 holds the exchange back: the longest of the Retry-After header
// (delta-seconds or an HTTP-date, RFC 9110 §10.2.3) and the body's wait fields, within
// [minRateLimitHold, maxRateLimitHold].
func rateLimitWait(header string, now time.Time, bodySeconds ...float64) time.Duration {
	wait := time.Duration(0)
	if h := strings.TrimSpace(header); h != "" {
		if secs, err := strconv.ParseInt(h, 10, 64); err == nil && secs >= 0 {
			wait = time.Duration(min(secs, int64(maxRateLimitHold/time.Second))) * time.Second
		} else if at, err := http.ParseTime(h); err == nil {
			wait = at.Sub(now)
		}
	}
	for _, secs := range bodySeconds {
		if secs > 0 {
			wait = max(wait, time.Duration(min(secs, maxRateLimitHold.Seconds())*float64(time.Second)))
		}
	}
	return min(max(wait, minRateLimitHold), maxRateLimitHold)
}

func safeCode(code string) string {
	if code == "" || len(code) > 64 || strings.ContainsAny(code, " \n\"") {
		return "none"
	}
	return code
}
