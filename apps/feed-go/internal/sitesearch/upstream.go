package sitesearch

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Timeout is SITE_SEARCH_TIMEOUT_MS: the bound Node puts on each search call.
const Timeout = 5 * time.Second

// maxUpstreamBody caps the bytes read from a search response. A page is about 1 MB; past this the
// request falls back rather than hold more.
const maxUpstreamBody = 32 << 20

// Response is a search backend's answer: its status and body bytes.
type Response struct {
	Status int
	Body   []byte
}

// Upstream answers one search call: a POST of body to path (`/multi-search`,
// `/indexes/<uid>/search`, `/indexes/<uid>/facet-search`). The shadow answers it from the response
// Node recorded for the same request (Recorded); the public route from the search backend (Client).
type Upstream interface {
	Post(ctx context.Context, path string, body []byte) (*Response, error)
}

// Client is postToSearch's backend: NEXT_PUBLIC_SEARCH_HOST with SEARCH_TOKEN_API_KEY (else
// SEARCH_API_KEY) as its bearer key, each call bounded by Timeout. Unlike the model search's client
// (v1models.MeiliClient) Node puts no circuit or limiter on this backend, and neither is one here: the
// serve slots bound the calls in flight.
type Client struct {
	host   string
	apiKey string
	http   *http.Client
}

// NewClient returns the client for host and apiKey ("" = no Authorization header, as Node sends none).
func NewClient(host, apiKey string) (*Client, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return nil, errors.New("sitesearch: no search host")
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.MaxIdleConnsPerHost = 16
	return &Client{host: host, apiKey: apiKey, http: &http.Client{Transport: tr, Timeout: Timeout}}, nil
}

// Post is postToSearch's call: `${host}${path}`, the JSON body, the bearer key.
func (c *Client) Post(ctx context.Context, path string, body []byte) (*Response, error) {
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, c.host+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	hr.Header.Set("Content-Type", "application/json")
	if c.apiKey != "" {
		hr.Header.Set("Authorization", "Bearer "+c.apiKey)
	}
	res, err := c.http.Do(hr) //nolint:gosec // G704: the configured search host, not a request-derived URL
	if err != nil {
		return nil, err
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxUpstreamBody+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > maxUpstreamBody {
		return nil, fmt.Errorf("sitesearch: response past %d bytes", maxUpstreamBody)
	}
	return &Response{Status: res.StatusCode, Body: raw}, nil
}

// Recorded is the search response Node recorded for a sampled request: the shadow reshapes it instead
// of asking the backend again, so the comparison is deterministic and costs the backend nothing.
type Recorded struct {
	Body []byte
}

// Post answers every call with the recorded 200 (Node posts only the samples it answered 200, which
// needed a 200 from the backend).
func (r Recorded) Post(context.Context, string, []byte) (*Response, error) {
	return &Response{Status: http.StatusOK, Body: r.Body}, nil
}
