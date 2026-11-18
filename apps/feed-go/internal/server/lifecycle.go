package server

import (
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Listener limits. Every limit is a bound on what one connection can hold, so a slow or stalled client
// cannot pin a goroutine and a socket for ever.
const (
	// MaxHeaderBytes is above what the Node app accepts (16 KiB by default), so nothing it would answer
	// is refused here, and far below net/http's 1 MiB default.
	MaxHeaderBytes = 64 << 10
	// ReadHeaderTimeout bounds the request line and headers on both listeners.
	ReadHeaderTimeout = 5 * time.Second
	// IdleTimeout closes a keep-alive connection idle this long.
	IdleTimeout = 120 * time.Second

	// PublicReadTimeout bounds reading a public request whole: the procedure is a GET with no body.
	PublicReadTimeout = 10 * time.Second
	// FallbackAllowance is the time on top of the request budget a public response may take to write:
	// a request this service hands to the Node app is answered by it, through the proxy, on the same
	// connection.
	FallbackAllowance = 60 * time.Second

	// InternalReadTimeout bounds reading an internal request whole, a shadow sample of up to
	// maxShadowBody (32 MiB) included.
	InternalReadTimeout = 60 * time.Second
	// InternalWriteTimeout bounds writing an internal response (a 202, a health check, a metrics
	// page). A pprof capture is exempt by construction: net/http/pprof's profile and trace handlers
	// move their own write deadline to WriteTimeout + seconds before they start, so
	// `profile?seconds=N` holds the connection N seconds and is not cut at 30 s.
	InternalWriteTimeout = 30 * time.Second
)

// PublicHTTPServer is the public listener: the served procedure under budget (0 = DefaultRequestBudget),
// with the write deadline sized for a response the fallback proxy relays.
func PublicHTTPServer(addr string, h http.Handler, budget time.Duration) *http.Server {
	if budget <= 0 {
		budget = DefaultRequestBudget
	}
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: ReadHeaderTimeout,
		ReadTimeout:       PublicReadTimeout,
		WriteTimeout:      budget + FallbackAllowance,
		IdleTimeout:       IdleTimeout,
		MaxHeaderBytes:    MaxHeaderBytes,
	}
}

// InternalHTTPServer is the internal listener: metrics, health, the shadow endpoints and pprof.
func InternalHTTPServer(addr string, h http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           h,
		ReadHeaderTimeout: ReadHeaderTimeout,
		ReadTimeout:       InternalReadTimeout,
		WriteTimeout:      InternalWriteTimeout,
		IdleTimeout:       IdleTimeout,
		MaxHeaderBytes:    MaxHeaderBytes,
	}
}

// DefaultDegradedLogEvery is how often a failed revocation read is logged at most.
const DefaultDegradedLogEvery = 10 * time.Second

// RevocationDegradedReporter is the revocation check's OnDegraded: every failed read is counted by the
// verdict it was then given (deny_cached | allow_unknown, as the app's session_revocation_degraded_total),
// and at most one warning per Every is logged (carrying how many were suppressed since the last one), so
// a system redis incident does not turn every signed-in request into a log line.
type RevocationDegradedReporter struct {
	Log     *slog.Logger
	Counter *prometheus.CounterVec // label: verdict
	Every   time.Duration          // 0 = DefaultDegradedLogEvery
	Now     func() time.Time

	mu         sync.Mutex
	last       time.Time
	suppressed int
}

// Report records one failed read and the verdict given.
func (f *RevocationDegradedReporter) Report(err error, verdict string) {
	if f.Counter != nil {
		f.Counter.WithLabelValues(verdict).Inc()
	}
	now := time.Now()
	if f.Now != nil {
		now = f.Now()
	}
	every := f.Every
	if every <= 0 {
		every = DefaultDegradedLogEvery
	}
	f.mu.Lock()
	if !f.last.IsZero() && now.Sub(f.last) < every {
		f.suppressed++
		f.mu.Unlock()
		return
	}
	suppressed := f.suppressed
	f.suppressed, f.last = 0, now
	f.mu.Unlock()
	f.Log.Warn("revocation read failed; answered from the markers already read", "err", err, "verdict", verdict,
		"suppressed", suppressed)
}
