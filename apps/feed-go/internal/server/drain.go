package server

import (
	"net/http"
	"sync/atomic"
)

// Readiness is the internal listener's /readyz: 200 until Drain begins, 503 after. Liveness stays on
// /healthz, which never fails here, so a draining pod leaves rotation without being restarted.
// The zero value is ready.
type Readiness struct{ draining atomic.Bool }

// StartDraining makes /readyz answer 503 from now on.
func (r *Readiness) StartDraining() { r.draining.Store(true) }

// Draining reports whether StartDraining has run.
func (r *Readiness) Draining() bool { return r.draining.Load() }

func (r *Readiness) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	if r.Draining() {
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusOK)
}

// Drain is the shutdown order: readiness fails first; then wait runs while every listener keeps
// serving, so a request routed here before the router has seen the failed readiness is still
// answered; then stop closes the listeners and drains what is in flight.
func Drain(r *Readiness, wait, stop func()) {
	r.StartDraining()
	wait()
	stop()
}
