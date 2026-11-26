package main

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/server"
)

// Off (the default), no writer starts and the server has no capture; on, both writers start, the
// server's capture carries the configured rates and DefaultEvalCaptureWorkers slots; a store URL that
// names no database refuses to start.
func TestNewEvalCapture(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := &server.Server{}
	s, c, err := newEvalCapture(&config.Config{}, srv, log)
	if err != nil || s != nil || c != nil || srv.EvalCapture != nil {
		t.Fatalf("off: writers %v %v, capture %+v, err %v; want none", s, c, srv.EvalCapture, err)
	}
	cfg := &config.Config{
		EvalCapture: true, EvalClickHouseURL: "http://127.0.0.1:1/evaldb", EvalClickHouseUser: "w", EvalClickHousePassword: "p",
		EvalCaptureServeRate: 0.01, EvalCaptureShadowRate: 0.2,
	}
	s, c, err = newEvalCapture(cfg, srv, log)
	if err != nil || s == nil || c == nil {
		t.Fatalf("on: writers %v %v, err %v", s, c, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	defer func() { _ = s.Close(ctx); _ = c.Close(ctx) }()
	e := srv.EvalCapture
	if e == nil || e.Recorder == nil || e.ServeRate != 0.01 || e.ShadowRate != 0.2 || cap(e.Queue) != 2 {
		t.Fatalf("capture %+v", e)
	}
	cfg.EvalClickHouseURL = "http://127.0.0.1:1"
	if _, _, err := newEvalCapture(cfg, &server.Server{}, log); err == nil {
		t.Error("a store URL with no database was accepted")
	}
}
