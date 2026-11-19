package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func clearDB(t *testing.T) {
	for _, k := range []string{"DATAPACKET_DATABASE_RO_URL", "DATABASE_REPLICA_URL", "DATABASE_URL"} {
		t.Setenv(k, "")
	}
}

func TestRunNeedsADatabase(t *testing.T) {
	clearDB(t)
	if err := run(quiet()); err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Fatalf("err = %v, want the missing database URL named", err)
	}
}

// An unparsable URL is refused without echoing it (it holds the password).
func TestRunRefusesABadDatabaseURL(t *testing.T) {
	clearDB(t)
	t.Setenv("DATABASE_URL", "postgres://user:hunter2@db.invalid:notaport/app")
	err := run(quiet())
	if err == nil || strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("err = %v, want an error that does not echo the URL", err)
	}
}

func freeAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	_ = l.Close()
	return addr
}

func handlerSaying(s string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, s) })
}

func get(addr string) (string, error) {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://"+addr+"/", nil)
	if err != nil {
		return "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = res.Body.Close() }()
	b, err := io.ReadAll(res.Body)
	return string(b), err
}

func waitServing(t *testing.T, addr, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got, err := get(addr); err == nil {
			if got != want {
				t.Fatalf("%s answered %q, want %q", addr, got, want)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s never served", addr)
}

// Both listeners serve their own handler, and the end of the run context shuts both down cleanly.
func TestServeRunsBothListenersUntilCancelled(t *testing.T) {
	a, b := freeAddr(t), freeAddr(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- serve(ctx, cancel, newServer(a, handlerSaying("api")), newServer(b, handlerSaying("metrics")))
	}()
	waitServing(t, a, "api")
	waitServing(t, b, "metrics")
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("serve = %v, want nil after the context ends", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("serve did not return after the context ended")
	}
	if _, err := get(b); err == nil {
		t.Fatal("the metrics listener still answers after shutdown")
	}
}

// A listener that cannot start (its address is taken) ends the run with that error and shuts the
// other listener down: the service never runs with one of the two missing.
func TestServeStopsWhenOneListenerFails(t *testing.T) {
	taken, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = taken.Close() }()
	a := freeAddr(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err = serve(ctx, cancel, newServer(a, handlerSaying("api")), newServer(taken.Addr().String(), handlerSaying("metrics")))
	if err == nil || !strings.Contains(err.Error(), "address already in use") {
		t.Fatalf("serve = %v, want the failed listen", err)
	}
	if ctx.Err() == nil {
		t.Fatal("the run context was not stopped")
	}
	if _, err := get(a); err == nil {
		t.Fatal("the API listener still answers after the metrics listener failed")
	}
}
