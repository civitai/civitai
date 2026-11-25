package v1models

import (
	"bytes"
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

// The text search of `GET /api/v1/models` (DESIGN.md §16.11): a truthy `query` asks the models search
// index for the page's ids (resolveModelSearchIds, src/server/services/model-search.service.ts),
// then getModelsRaw reads those ids and the answer keeps the index's order.

// ModelsSearchIndex is MODELS_SEARCH_INDEX (packages/civitai-shared/src/search-index-queue.ts), the
// index resolveModelSearchIds searches.
const ModelsSearchIndex = "models_v9"

// DefaultSearchTimeout is MEILI_CALL_TIMEOUT_MS's default (src/env/server-schema.ts): the bound the
// Node app puts on each search call.
const DefaultSearchTimeout = 2500 * time.Millisecond

// MaxSearchTimeout caps the bound here, whatever MEILI_CALL_TIMEOUT_MS says. A search holds one of the
// pod's serve slots while it waits, and a search that runs out its bound is handed to the Node app,
// which then makes its own call, bounded by its own MEILI_CALL_TIMEOUT_MS: a longer bound here (one
// raised for the Node app's other searches) would hold the slot longer and leave less of the request
// budget (DefaultRequestBudget, 6 s) to the statements and to that second call.
const MaxSearchTimeout = 2500 * time.Millisecond

// The guard on the search calls (MeiliClient.SearchModelIDs), the Node app's runWithLimiter for its
// `search` backend (src/server/meilisearch/client.ts): a concurrency cap and a circuit breaker, so a
// search brownout cannot hold this pod's serve slots and push its other routes into bulkhead
// fallbacks. A rejected call never reaches the backend and returns ErrSearchRejected at once.
const (
	// SearchConcurrency is the cap on the search calls in flight per process: half of the pod's
	// default serve slots, so text queries alone can never fill them. Unlike the Node app's limiter
	// (MEILI_CALL_CONCURRENCY, a queue), a call past the cap is not queued: it is rejected.
	SearchConcurrency = 4
	// DefaultCircuitTripThreshold, DefaultCircuitWindow and DefaultCircuitCooldown are the Node app's
	// MEILI_CIRCUIT_TRIP_THRESHOLD, MEILI_CIRCUIT_WINDOW_SECONDS and MEILI_CIRCUIT_COOLDOWN_SECONDS
	// defaults: that many timed-out calls within the window open the circuit, which rejects every
	// call for the cooldown, then admits one trial call (half-open) whose outcome closes or reopens it.
	DefaultCircuitTripThreshold = 10
	DefaultCircuitWindow        = 30 * time.Second
	DefaultCircuitCooldown      = 30 * time.Second
)

// ErrSearchRejected is a search call the guard did not make: the circuit is open (or its half-open
// trial is in flight), or SearchConcurrency calls are already in flight.
var ErrSearchRejected = errors.New("search: rejected (circuit open or concurrency cap reached)")

// Rejection reasons passed to MeiliClient.OnReject.
const (
	SearchRejectedOpen = "open"
	SearchRejectedBusy = "busy"
)

type circuitState int

const (
	circuitClosed circuitState = iota
	circuitHalfOpen
	circuitOpen
)

// circuit is the Node app's per-backend Circuit: the counted failures' times within the window, the
// state, the end of an open cooldown, and whether the half-open trial is in flight.
type circuit struct {
	mu            sync.Mutex
	threshold     int
	window        time.Duration
	cooldown      time.Duration
	failures      []time.Time
	state         circuitState
	cooldownUntil time.Time
	trialInFlight bool
}

func (c *circuit) prune(now time.Time) {
	cutoff := now.Add(-c.window)
	i := 0
	for i < len(c.failures) && c.failures[i].Before(cutoff) {
		i++
	}
	c.failures = c.failures[i:]
}

func (c *circuit) transition(next circuitState, now time.Time) {
	if c.state == next {
		return
	}
	c.state = next
	switch next {
	case circuitOpen:
		c.cooldownUntil = now.Add(c.cooldown)
		c.trialInFlight = false
	case circuitHalfOpen:
		c.trialInFlight = false
	case circuitClosed:
		c.failures = nil
		c.cooldownUntil = time.Time{}
		c.trialInFlight = false
	}
}

// admit is admitCall: whether the call may proceed, and whether it is the half-open trial.
func (c *circuit) admit(now time.Time) (admitted, trial bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prune(now)
	if c.state == circuitOpen {
		if now.Before(c.cooldownUntil) {
			return false, false
		}
		c.transition(circuitHalfOpen, now)
	}
	if c.state == circuitHalfOpen {
		if c.trialInFlight {
			return false, false
		}
		c.trialInFlight = true
		return true, true
	}
	return true, false
}

// abandonTrial gives the trial slot back when an admitted trial was not made (the concurrency cap).
func (c *circuit) abandonTrial() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == circuitHalfOpen {
		c.trialInFlight = false
	}
}

// record is recordCallOutcome: a trial's outcome closes or reopens the circuit; otherwise a counted
// failure that brings the window's count to the threshold opens it.
func (c *circuit) record(now time.Time, trial, failed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.prune(now)
	if failed {
		c.failures = append(c.failures, now)
	}
	if trial {
		c.trialInFlight = false
		if failed {
			c.transition(circuitOpen, now)
		} else {
			c.transition(circuitClosed, now)
		}
		return
	}
	if c.state == circuitClosed && failed && len(c.failures) >= c.threshold {
		c.transition(circuitOpen, now)
	}
}

// countedFailure is what the Node app counts toward its circuit: a call that ran out its own bound
// (MeiliCallTimeoutError). A call cut short by its caller (a gone client, the request budget, a
// shadow sample's bound) says nothing about the backend, nor does a fast error.
func countedFailure(ctx context.Context, err error) bool {
	if err == nil || ctx.Err() != nil {
		return false
	}
	var ne interface{ Timeout() bool }
	return errors.As(err, &ne) && ne.Timeout()
}

// SearchRequest is one `index.search(query, options)` call of resolveModelSearchIds.
type SearchRequest struct {
	Index string
	Query string
	// Offset is `queryOffset || undefined`: 0 is left out of the request.
	Offset int
	// Limit is `limit + 1`: the lookahead hit says whether there is a next page.
	Limit  int
	Filter []string
	// Sort is meiliSortForModelSort of a sort the caller named; nil = not sent (relevance).
	Sort []string
}

// searchBody is the JSON meilisearch-js POSTs to `indexes/<uid>/search`: `{ q, ...options }`, with
// the members JSON.stringify drops (undefined) left out, in the options' key order.
type searchBody struct {
	Q                    string   `json:"q"`
	Offset               int      `json:"offset,omitempty"`
	Limit                int      `json:"limit"`
	Filter               []string `json:"filter"`
	AttributesToRetrieve []string `json:"attributesToRetrieve"`
	Sort                 []string `json:"sort,omitempty"`
}

// Body is the request body Node's search call sends.
func (r SearchRequest) Body() ([]byte, error) {
	filter := r.Filter
	if filter == nil {
		filter = []string{}
	}
	return json.Marshal(searchBody{
		Q: r.Query, Offset: r.Offset, Limit: r.Limit, Filter: filter,
		AttributesToRetrieve: []string{"id"}, Sort: r.Sort,
	})
}

// ModelSearcher answers a SearchRequest with the hits' ids, in the index's order. Any error is a
// fallback: the Node app then makes its own call and decides its own answer (a 503 on a brownout).
type ModelSearcher interface {
	SearchModelIDs(ctx context.Context, req SearchRequest) ([]int, error)
}

// MeiliClient is the search backend the Node app's `searchClient` talks to: SEARCH_HOST with
// SEARCH_API_KEY, read the way meilisearch-js reads them.
type MeiliClient struct {
	// base is SEARCH_HOST as meilisearch-js resolves it: `http://` added when no protocol is given, a
	// trailing slash added.
	base   *url.URL
	apiKey string
	http   *http.Client
	// slots holds one token per search call in flight (SearchConcurrency).
	slots   chan struct{}
	circuit *circuit
	now     func() time.Time
	// OnReject, when set, is told of each rejected call (SearchRejectedOpen | SearchRejectedBusy).
	OnReject func(why string)
}

// maxSearchResponse bounds a search response read: at most 101 hits of one id each.
const maxSearchResponse = 1 << 20

// NewMeiliClient returns the client for host (SEARCH_HOST) and apiKey (SEARCH_API_KEY), each call
// bounded by timeout (MEILI_CALL_TIMEOUT_MS; 0 = DefaultSearchTimeout, at most MaxSearchTimeout),
// guarded by the default circuit (SetCircuit) and SearchConcurrency.
func NewMeiliClient(host, apiKey string, timeout time.Duration) (*MeiliClient, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return nil, errors.New("no search host")
	}
	// addProtocolIfNotPresent, then addTrailingSlash (meilisearch-js HttpRequests).
	if !strings.HasPrefix(host, "https://") && !strings.HasPrefix(host, "http://") {
		host = "http://" + host
	}
	if !strings.HasSuffix(host, "/") {
		host += "/"
	}
	u, err := url.Parse(host)
	if err != nil {
		return nil, fmt.Errorf("search host: %w", err)
	}
	if timeout <= 0 {
		timeout = DefaultSearchTimeout
	}
	timeout = min(timeout, MaxSearchTimeout)
	tr := http.DefaultTransport.(*http.Transport).Clone()
	// As many idle connections as calls in flight: past the default 2, a burst would open (and
	// close) a new connection per call.
	tr.MaxIdleConnsPerHost = SearchConcurrency
	c := &MeiliClient{
		base:   u,
		apiKey: apiKey,
		http:   &http.Client{Transport: tr, Timeout: timeout},
		slots:  make(chan struct{}, SearchConcurrency),
		now:    time.Now,
	}
	c.SetCircuit(0, 0, 0)
	return c, nil
}

// SetCircuit sets the circuit's trip threshold, window and cooldown (MEILI_CIRCUIT_TRIP_THRESHOLD,
// MEILI_CIRCUIT_WINDOW_SECONDS, MEILI_CIRCUIT_COOLDOWN_SECONDS; each 0 = the Node app's default),
// with the circuit closed. Call it before the client is used.
func (c *MeiliClient) SetCircuit(threshold int, window, cooldown time.Duration) {
	if threshold <= 0 {
		threshold = DefaultCircuitTripThreshold
	}
	if window <= 0 {
		window = DefaultCircuitWindow
	}
	if cooldown <= 0 {
		cooldown = DefaultCircuitCooldown
	}
	c.circuit = &circuit{threshold: threshold, window: window, cooldown: cooldown}
}

func (c *MeiliClient) reject(why string) error {
	if c.OnReject != nil {
		c.OnReject(why)
	}
	return ErrSearchRejected
}

// searchHits is the part of a search response read: each hit's `id`.
type searchHits struct {
	Hits []struct {
		ID json.RawMessage `json:"id"`
	} `json:"hits"`
}

// SearchModelIDs POSTs the search and reads the hits' ids. A response other than a 2xx, a body that
// is not a search response, or a hit whose id is not an integer is an error. With the circuit open,
// or SearchConcurrency calls in flight, it returns ErrSearchRejected without a call.
func (c *MeiliClient) SearchModelIDs(ctx context.Context, req SearchRequest) ([]int, error) {
	// The circuit first, then the cap (runWithLimiter: admitCall before the limiter).
	admitted, trial := c.circuit.admit(c.now())
	if !admitted {
		return nil, c.reject(SearchRejectedOpen)
	}
	select {
	case c.slots <- struct{}{}:
	default:
		if trial {
			c.circuit.abandonTrial()
		}
		return nil, c.reject(SearchRejectedBusy)
	}
	ids, err := c.search(ctx, req)
	<-c.slots
	c.circuit.record(c.now(), trial, countedFailure(ctx, err))
	return ids, err
}

// search is the call itself.
func (c *MeiliClient) search(ctx context.Context, req SearchRequest) ([]int, error) {
	body, err := req.Body()
	if err != nil {
		return nil, err
	}
	target := c.base.ResolveReference(&url.URL{Path: "indexes/" + req.Index + "/search"})
	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
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
	raw, err := io.ReadAll(io.LimitReader(res.Body, maxSearchResponse+1))
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, fmt.Errorf("search: status %d", res.StatusCode)
	}
	if len(raw) > maxSearchResponse {
		return nil, errors.New("search: response too large")
	}
	return parseSearchHits(raw)
}

// parseSearchHits reads the hits' ids from a search response body.
func parseSearchHits(raw []byte) ([]int, error) {
	var out searchHits
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("search: %w", err)
	}
	if out.Hits == nil {
		return nil, errors.New("search: no hits in the response")
	}
	ids := make([]int, len(out.Hits))
	for i, h := range out.Hits {
		// A JSON integer literal only: a string, a fraction or an exponent is not a model id.
		n, err := strconv.ParseInt(string(h.ID), 10, 32)
		if err != nil || n <= 0 {
			return nil, fmt.Errorf("search: hit %d has no integer id", i)
		}
		ids[i] = int(n)
	}
	return ids, nil
}

// meiliSortForModelSort is the function of that name: the search sort for a model sort, nil when
// the sort has no search attribute (relevance).
func meiliSortForModelSort(sort string) []string {
	var attribute string
	switch sort {
	case SortHighestRated, SortMostLiked:
		attribute = "metrics.thumbsUpCount:desc"
	case SortMostDownloaded:
		attribute = "metrics.downloadCount:desc"
	case SortMostDiscussed:
		attribute = "metrics.commentCount:desc"
	case SortMostCollected:
		attribute = "metrics.collectedCount:desc"
	case SortNewest:
		attribute = "createdAt:desc"
	case SortOldest:
		attribute = "createdAt:asc"
	default:
		return nil
	}
	return []string{attribute, "id:desc"}
}

// levelValues is Flags.instanceToArray(level): the level's bits, lowest first.
func levelValues(level int) []string {
	var out []string
	for v := level; v > 0; v &= v - 1 {
		out = append(out, strconv.Itoa(v&-v))
	}
	return out
}

// meiliQuote is meili-filter's quote of a string: double-quoted, `\` and `"` escaped.
func meiliQuote(s string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
}

// searchRequest is resolveModelSearchIds' call for a list request at level: the public route's
// options (no owner, no `supportsGeneration`: a request naming it falls back before this).
func searchRequest(in *ListInput, level int) SearchRequest {
	filter := []string{"nsfwLevel IN [" + strings.Join(levelValues(level), ",") + "]"}
	if len(in.Types) > 0 {
		// Every type is a ModelType value (ParseList refuses any other), so none is dropped.
		filter = append(filter, "type IN ["+strings.Join(in.Types, ",")+"]")
	}
	if len(in.BaseModels) > 0 {
		quoted := make([]string, len(in.BaseModels))
		for i, b := range in.BaseModels {
			quoted[i] = meiliQuote(b)
		}
		filter = append(filter, "versions.baseModel IN ["+strings.Join(quoted, ", ")+"]")
	}
	req := SearchRequest{
		Index: ModelsSearchIndex, Query: in.Text, Offset: in.TextOffset, Limit: in.Limit + 1, Filter: filter,
	}
	if in.SortNamed {
		// Only a sort the caller named: the schema's default would rank every text search by it.
		req.Sort = meiliSortForModelSort(in.Sort)
	}
	return req
}
