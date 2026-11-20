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
package exchange

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// The RFC 8693 names the hub reads (apps/auth/src/lib/server/oauth/constants.ts).
const (
	GrantType       = "urn:ietf:params:oauth:grant-type:token-exchange"
	AccessTokenType = "urn:ietf:params:oauth:token-type:access_token" //nolint:gosec // G101: an RFC 8693 token-type name, not a credential
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

// Exchanger calls the hub.
type Exchanger struct {
	Config
	// HTTP is the client; nil is http.DefaultClient. Calls are bounded by their context.
	HTTP *http.Client
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

// Exchange trades subject, a user's hub access token, for a token toward Resource.
func (e *Exchanger) Exchange(ctx context.Context, subject string) (Token, error) {
	form := url.Values{
		"grant_type":         {GrantType},
		"subject_token":      {subject},
		"subject_token_type": {AccessTokenType},
		"resource":           {e.Resource},
		"scope":              {Scope},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, e.URL, strings.NewReader(form.Encode()))
	if err != nil {
		return Token{}, errors.New("exchange: request could not be built")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	// RFC 6749 §2.3.1: the id and secret are form-encoded before Basic encoding.
	req.SetBasicAuth(url.QueryEscape(e.ClientID), url.QueryEscape(e.ClientSecret))
	hc := e.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	now := time.Now
	if e.Now != nil {
		now = e.Now
	}
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
	}
	_ = json.Unmarshal(raw, &body)
	switch {
	case res.StatusCode == http.StatusBadRequest || res.StatusCode == http.StatusUnauthorized:
		// invalid_grant, unauthorized_client, invalid_scope, invalid_client: a fact about this
		// subject or this client, not a transient failure.
		return Token{}, fmt.Errorf("%w (HTTP %d, %s)", ErrRefused, res.StatusCode, safeCode(body.Error))
	case res.StatusCode/100 != 2:
		return Token{}, fmt.Errorf("exchange: token endpoint answered HTTP %d (%s)", res.StatusCode, safeCode(body.Error))
	case body.AccessToken == "" || body.ExpiresIn <= 0:
		return Token{}, errors.New("exchange: answer without an access_token and its lifetime")
	}
	// Measured from before the call, so the expiry is never later than the hub's.
	return Token{Access: body.AccessToken, Expires: start.Add(time.Duration(body.ExpiresIn * float64(time.Second)))}, nil
}

func safeCode(code string) string {
	if code == "" || len(code) > 64 || strings.ContainsAny(code, " \n\"") {
		return "none"
	}
	return code
}
