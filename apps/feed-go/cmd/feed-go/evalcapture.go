package main

import (
	"log/slog"

	"github.com/civitai/civitai/apps/feed-go/internal/chwrite"
	"github.com/civitai/civitai/apps/feed-go/internal/config"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
	"github.com/civitai/civitai/apps/feed-go/internal/server"
)

// newEvalCapture sets srv.EvalCapture for FEED_GO_EVAL_CAPTURE (DESIGN.md §19.6) and returns the two
// writers it feeds, to be closed at shutdown after the taps have stopped. Off (the default) it does
// nothing and returns nil writers: no writer is started, no tap does anything.
func newEvalCapture(cfg *config.Config, srv *server.Server, log *slog.Logger) (samples, cases *chwrite.Writer, err error) {
	if !cfg.EvalCapture {
		return nil, nil, nil
	}
	samples, cases, err = evalcapture.NewWriters(evalcapture.WriterConfig{
		URL: cfg.EvalClickHouseURL, Username: cfg.EvalClickHouseUser, Password: cfg.EvalClickHousePassword,
		// A failed batch's error can quote rows: stripped requests and signed-out Node answers only
		// (evalcapture.Record), so it may be logged.
		OnError: func(err error) { log.Warn("eval capture insert failed", "err", err) },
	})
	if err != nil {
		return nil, nil, err
	}
	srv.EvalCapture = &server.EvalCapture{
		Recorder: evalcapture.New(evalcapture.Config{
			Samples: samples, Cases: cases,
			HostColors: cfg.Hosts, RegionRules: cfg.RegionRules, RegionBlockRules: cfg.RegionBlockRules,
			GoVersion: version,
		}),
		ShadowRate: cfg.EvalCaptureShadowRate,
		ServeRate:  cfg.EvalCaptureServeRate,
		Queue:      make(chan struct{}, server.DefaultEvalCaptureWorkers),
	}
	return samples, cases, nil
}
