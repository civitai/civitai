// Package flipt reads one global boolean Flipt flag, the way the Node app's cached flag gate does
// (createCachedFlagGate over isFliptSync, src/server/utils/cached-flag-gate.ts): evaluated with the
// entity id 'global' and no context, at most once per refresh window, and any failure reads as OFF.
//
// It is the standard library on purpose, not go.flipt.io/flipt-client (the in-process engine the Go
// services are to adopt, packages/civitai-flipt/parity, which brings a wasm runtime with it): this
// service reads one global on/off switch, so it asks the server to evaluate it
// (POST /evaluate/v1/boolean) with the URL, client token and Flipt environment the Node app's client
// uses (FLIPT_URL, FLIPT_FETCHER_SECRET, FLIPT_ENVIRONMENT). The server's evaluator is not the
// engine Node runs, so only a flag's plain on/off is claimed to answer both runtimes alike; a
// percentage rollout or segment rule on a flag read here is not parity-checked. Use it for global
// boolean switches only, and move to the shared client when feed-go adopts it.
package flipt

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"time"
)

// DefaultEnvironment is FLIPT_ENVIRONMENT's default, as in packages/civitai-flipt/src/env.ts.
const DefaultEnvironment = "civitai-app"

// GlobalEntityID is the entity id Node's client evaluates a flag with when the caller names none.
const GlobalEntityID = "global"

// RefreshInterval is CACHED_FLAG_GATE_REFRESH_MS: how long one read of a flag is reused. A flip takes
// effect within it.
const RefreshInterval = 5 * time.Second

// Config is where Flipt is.
type Config struct {
	// URL is FLIPT_URL: the server's base URL.
	URL string
	// ClientToken is FLIPT_FETCHER_SECRET, sent as a bearer token.
	ClientToken string
	// Environment is FLIPT_ENVIRONMENT ("" is DefaultEnvironment).
	Environment string
	// Timeout bounds one evaluation request (0: RefreshInterval, so a hung server never holds more
	// than one read at a time).
	Timeout time.Duration
	// HTTP is the client (nil: a dedicated one).
	HTTP *http.Client
}

// Client evaluates boolean flags. Safe for concurrent use.
type Client struct {
	endpoint string
	token    string
	env      string
	timeout  time.Duration
	http     *http.Client
}

// New validates cfg: the URL must be absolute http(s).
func New(cfg Config) (*Client, error) {
	u, err := url.Parse(cfg.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		// Not wrapped: url.Parse's error repeats the URL.
		return nil, errors.New("flipt url: want an absolute http(s) URL")
	}
	env := cfg.Environment
	if env == "" {
		env = DefaultEnvironment
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = RefreshInterval
	}
	hc := cfg.HTTP
	if hc == nil {
		hc = &http.Client{Transport: http.DefaultTransport.(*http.Transport).Clone()}
	}
	return &Client{endpoint: strings.TrimRight(cfg.URL, "/") + "/evaluate/v1/boolean", token: cfg.ClientToken, env: env,
		timeout: timeout, http: hc}, nil
}

type booleanRequest struct {
	NamespaceKey string            `json:"namespaceKey"`
	FlagKey      string            `json:"flagKey"`
	EntityID     string            `json:"entityId"`
	Context      map[string]string `json:"context"`
}

// Boolean evaluates flag for the global entity with no context. Anything but a 200 whose body
// carries a boolean `enabled` is an error (an unknown flag included: Flipt answers it 404).
func (c *Client) Boolean(ctx context.Context, flag string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	body, err := json.Marshal(booleanRequest{NamespaceKey: "default", FlagKey: flag, EntityID: GlobalEntityID, Context: map[string]string{}})
	if err != nil {
		return false, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(body))
	if err != nil {
		return false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-Flipt-Environment", c.env)
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		return false, fmt.Errorf("flipt: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4<<10))
		return false, fmt.Errorf("flipt: %s: http %d", flag, resp.StatusCode)
	}
	var out struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out); err != nil {
		return false, fmt.Errorf("flipt: %s: %w", flag, err)
	}
	if out.Enabled == nil {
		return false, fmt.Errorf("flipt: %s: no enabled field", flag)
	}
	return *out.Enabled, nil
}

// Switch is one global boolean flag, read in the background so a request never waits on Flipt.
// On is false until the first read succeeds, and after any read that fails (as the Node gate reads
// null or a throw as OFF), so a Flipt this process cannot reach keeps the flag's code path off.
type Switch struct {
	read func(ctx context.Context) (bool, error)
	on   atomic.Bool
	// OnError, when set, sees every failed read.
	OnError func(err error)
}

// NewSwitch is a switch over read (Client.Boolean of one flag, in production).
func NewSwitch(read func(ctx context.Context) (bool, error)) *Switch {
	return &Switch{read: read}
}

// On is the last read's answer (false before the first one and after a failed one).
func (s *Switch) On() bool {
	return s != nil && s.on.Load()
}

// Refresh reads the flag once and keeps the answer.
func (s *Switch) Refresh(ctx context.Context) {
	on, err := s.read(ctx)
	if err != nil {
		on = false
		if s.OnError != nil {
			s.OnError(err)
		}
	}
	s.on.Store(on)
}

// Run reads the flag now and then on every tick until ctx ends.
func (s *Switch) Run(ctx context.Context, ticks <-chan time.Time) {
	s.Refresh(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticks:
			s.Refresh(ctx)
		}
	}
}

// Start runs the switch every RefreshInterval in its own goroutine until ctx ends.
func (s *Switch) Start(ctx context.Context) {
	t := time.NewTicker(RefreshInterval)
	go func() {
		defer t.Stop()
		s.Run(ctx, t.C)
	}()
}
