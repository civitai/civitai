package evalharness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Clock is the run's time: Now, and a Sleep that ends early (with ctx's error) when ctx does. Tests
// inject a fake one that advances on Sleep.
type Clock interface {
	Now() time.Time
	Sleep(ctx context.Context, d time.Duration) error
}

// RealClock is the wall clock.
type RealClock struct{}

// Now is time.Now.
func (RealClock) Now() time.Time { return time.Now() }

// Sleep waits d, or until ctx ends.
func (RealClock) Sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// TokenBucket paces every outbound call of a run, Node and Go alike: Rate tokens a second, at most
// Burst held. Safe for concurrent use.
type TokenBucket struct {
	clock  Clock
	rate   float64
	burst  float64
	mu     sync.Mutex
	tokens float64
	last   time.Time
}

// NewTokenBucket is a full bucket.
func NewTokenBucket(clk Clock, rate float64, burst int) *TokenBucket {
	return &TokenBucket{clock: clk, rate: rate, burst: float64(burst), tokens: float64(burst), last: clk.Now()}
}

// Wait takes n tokens, waiting until they are there (n is at most the burst), or ctx's error.
func (b *TokenBucket) Wait(ctx context.Context, n int) error {
	need := math.Min(float64(n), b.burst)
	for {
		b.mu.Lock()
		now := b.clock.Now()
		if el := now.Sub(b.last).Seconds(); el > 0 {
			b.tokens = math.Min(b.burst, b.tokens+el*b.rate)
		}
		b.last = now
		if b.tokens >= need {
			b.tokens -= need
			b.mu.Unlock()
			return nil
		}
		wait := time.Duration((need - b.tokens) / b.rate * float64(time.Second))
		b.mu.Unlock()
		if wait < time.Millisecond {
			wait = time.Millisecond
		}
		if err := b.clock.Sleep(ctx, wait); err != nil {
			return err
		}
	}
}

// Window is the daily UTC run window [Start, End), as minutes of the day; End before Start wraps
// midnight.
type Window struct{ Start, End int }

// DefaultWindow is 03:00-08:00 UTC.
var DefaultWindow = Window{Start: 3 * 60, End: 8 * 60}

// ParseWindow reads "HH:MM-HH:MM".
func ParseWindow(s string) (Window, error) {
	a, b, ok := strings.Cut(s, "-")
	if !ok {
		return Window{}, errors.New("window: want HH:MM-HH:MM")
	}
	start, err := parseClock(a)
	if err != nil {
		return Window{}, err
	}
	end, err := parseClock(b)
	if err != nil {
		return Window{}, err
	}
	if start == end {
		return Window{}, errors.New("window: empty")
	}
	return Window{Start: start, End: end}, nil
}

func parseClock(s string) (int, error) {
	t, err := time.Parse("15:04", strings.TrimSpace(s))
	if err != nil {
		return 0, fmt.Errorf("window: %q is not HH:MM", s)
	}
	return t.Hour()*60 + t.Minute(), nil
}

// Contains reports whether t (read in UTC) is inside the window.
func (w Window) Contains(t time.Time) bool {
	t = t.UTC()
	m := t.Hour()*60 + t.Minute()
	if w.Start < w.End {
		return m >= w.Start && m < w.End
	}
	return m >= w.Start || m < w.End
}

func (w Window) String() string {
	return fmt.Sprintf("%02d:%02d-%02d:%02d", w.Start/60, w.Start%60, w.End/60, w.End%60)
}

// HealthCheck is one Prometheus guard: the run pauses while Query's largest sample exceeds Max.
type HealthCheck struct {
	Name  string  `json:"name"`
	Query string  `json:"query"`
	Max   float64 `json:"max"`
}

// ParseHealthCheck reads `name=<promql>;max=<float>` (the PromQL may hold `;` and `=`: the name ends at
// the first `=`, the query at the last `;max=`).
func ParseHealthCheck(s string) (HealthCheck, error) {
	i := strings.LastIndex(s, ";max=")
	if i < 0 {
		return HealthCheck{}, errors.New("health: want name=<promql>;max=<float>")
	}
	head, maxText := s[:i], s[i+len(";max="):]
	name, query, ok := strings.Cut(head, "=")
	if !ok || !roleRE.MatchString(name) || strings.TrimSpace(query) == "" {
		return HealthCheck{}, errors.New("health: want name=<promql>;max=<float>, name [a-z][a-z0-9-]*")
	}
	m, err := strconv.ParseFloat(strings.TrimSpace(maxText), 64)
	if err != nil || math.IsNaN(m) {
		return HealthCheck{}, errors.New("health: max is not a number")
	}
	return HealthCheck{Name: name, Query: query, Max: m}, nil
}

// LoadHealthChecks reads a JSON array of HealthCheck.
func LoadHealthChecks(path string) ([]HealthCheck, error) {
	b, err := os.ReadFile(path) //nolint:gosec // G304: the operator's own config path
	if err != nil {
		return nil, fmt.Errorf("health file: %w", err)
	}
	var out []HealthCheck
	if err := json.Unmarshal(b, &out); err != nil {
		return nil, fmt.Errorf("health file: %w", err)
	}
	for _, c := range out {
		if !roleRE.MatchString(c.Name) || strings.TrimSpace(c.Query) == "" {
			return nil, fmt.Errorf("health file: check %q: want a name [a-z][a-z0-9-]* and a query", c.Name)
		}
	}
	return out, nil
}

// Health asks Prometheus whether production can take the run's load.
type Health struct {
	// PromURL is Prometheus's base URL (its /api/v1/query is asked).
	PromURL string
	Checks  []HealthCheck
	HTTP    *http.Client
	// Timeout bounds one query (0: 10s).
	Timeout time.Duration
}

// Check runs every check once. ok false names the first failing check and why: `<name>:breach` (a
// sample over max), `<name>:no-data` (no sample: a guard that cannot see is not a healthy one), or
// `<name>:unreachable` (Prometheus did not answer, or answered something else).
func (h *Health) Check(ctx context.Context) (bool, string) {
	for _, c := range h.Checks {
		v, n, err := h.query(ctx, c.Query)
		switch {
		case err != nil:
			return false, c.Name + ":unreachable"
		case n == 0:
			return false, c.Name + ":no-data"
		case v > c.Max || math.IsNaN(v):
			return false, c.Name + ":breach"
		}
	}
	return true, ""
}

// query is the largest sample of an instant query and the number of samples.
func (h *Health) query(ctx context.Context, q string) (float64, int, error) {
	timeout := h.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	u, err := url.Parse(strings.TrimRight(h.PromURL, "/") + "/api/v1/query")
	if err != nil {
		return 0, 0, errors.New("prometheus url: not a URL")
	}
	u.RawQuery = url.Values{"query": {q}}.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return 0, 0, err
	}
	hc := h.HTTP
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return 0, 0, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return 0, 0, err
	}
	if resp.StatusCode != http.StatusOK {
		return 0, 0, fmt.Errorf("prometheus: http %d", resp.StatusCode)
	}
	var r struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string          `json:"resultType"`
			Result     json.RawMessage `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &r); err != nil || r.Status != "success" {
		return 0, 0, errors.New("prometheus: not a success answer")
	}
	var values [][]any
	switch r.Data.ResultType {
	case "vector":
		var vec []struct {
			Value []any `json:"value"`
		}
		if err := json.Unmarshal(r.Data.Result, &vec); err != nil {
			return 0, 0, err
		}
		for _, s := range vec {
			values = append(values, s.Value)
		}
	case "scalar":
		var sc []any
		if err := json.Unmarshal(r.Data.Result, &sc); err != nil {
			return 0, 0, err
		}
		values = append(values, sc)
	default:
		return 0, 0, errors.New("prometheus: want a vector or scalar")
	}
	best, n := math.Inf(-1), 0
	for _, v := range values {
		if len(v) != 2 {
			continue
		}
		s, ok := v[1].(string)
		if !ok {
			continue
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			continue
		}
		n++
		if math.IsNaN(f) || f > best {
			best = f
		}
	}
	return best, n, nil
}
