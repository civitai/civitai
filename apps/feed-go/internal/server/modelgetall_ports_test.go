package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus"

	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
)

// goldenPortFixtures are the served model-getall fixtures of the `ids` / `followed` ports, each with
// the reason the same request falls back with while its switch is off.
var goldenPortFixtures = map[string]string{
	"ids-embed-signed-out":      "input-ids",
	"ids-comma-string-showcase": "input-ids",
	"ids-empty-string":          "input-ids",
	"ids-empty-list":            "input-ids",
	"followed-signed-in":        "input-followed",
	"followed-no-follows":       "input-followed",
	"followed-signed-out":       "input-followed",
}

// Each port's switch decides it: on (the fixture's config), the request is computed and is Node's
// answer (the golden harness compares it); off, the same request is the fallback it always was, and
// no page is queried.
func TestModelGetAllPortsSwitch(t *testing.T) {
	for name, offReason := range goldenPortFixtures {
		t.Run(name, func(t *testing.T) {
			fx := goldenLoad(t, filepath.Join(goldenDir, "model-getall", name+".json"))
			if !fx.Config.ServeInputIDs && !fx.Config.ServeInputFollowed {
				t.Fatal("a port fixture must switch its port on")
			}
			goldenRunModels(t, fx)
			off := *fx
			off.Config.ServeInputIDs, off.Config.ServeInputFollowed = false, false
			off.Expect.Fallback = offReason
			if _, err := goldenComputeModels(t, &off); fallback.Reason(err) != offReason {
				t.Fatalf("switch off: %v (reason %q), want %q", err, fallback.Reason(err), offReason)
			}
		})
	}
}

// The shadow compares the ported shapes: a Node sample of each port fixture is computed and is a
// `match` with its switch on, and `unsupported` (the old fallback) with it off.
func TestModelGetAllPortsShadow(t *testing.T) {
	for name, offReason := range goldenPortFixtures {
		for _, on := range []bool{true, false} {
			t.Run(name+map[bool]string{true: "/on", false: "/off"}[on], func(t *testing.T) {
				fx := goldenLoad(t, filepath.Join(goldenDir, "model-getall", name+".json"))
				node := fx.Expect.Envelope
				if len(node) == 0 {
					t.Fatalf("%s records no envelope", name)
				}
				want := "match"
				if !on {
					c := *fx
					c.Config.ServeInputIDs, c.Config.ServeInputFollowed = false, false
					c.Expect.Fallback = offReason
					fx, want = &c, "unsupported"
				}
				env := goldenSetupModels(t, fx)
				reg := prometheus.NewRegistry()
				s := env.server
				s.Metrics = NewMetrics(reg)
				s.Log = slog.New(slog.NewTextHandler(io.Discard, nil))
				s.ShadowQueue = make(chan struct{}, 1)
				body, err := json.Marshal(ShadowRequest{Input: fx.Request.Input, Headers: env.headers, Node: node})
				if err != nil {
					t.Fatal(err)
				}
				w := httptest.NewRecorder()
				s.ShadowModelGetAllHandler(w, httptest.NewRequestWithContext(context.Background(), http.MethodPost, "/internal/shadow/model.getAll", strings.NewReader(string(body))))
				if w.Code != http.StatusAccepted {
					t.Fatalf("code %d, want 202", w.Code)
				}
				waitFor(t, want, func() bool {
					v, _ := metricValue(t, reg, "feed_go_shadow_compare_total", map[string]string{"feed_endpoint": EndpointModelGetAll, "result": want})
					return v == 1 && len(s.ShadowQueue) == 0
				})
				if !on {
					if n, _ := metricValue(t, reg, "feed_go_fallback_total", map[string]string{"feed_endpoint": EndpointModelGetAll, "mode": "shadow", "reason": offReason}); n != 1 {
						t.Fatalf("shadow fallback %s = %v, want 1", offReason, n)
					}
				}
				if err := s.Close(context.Background()); err != nil {
					t.Fatal(err)
				}
			})
		}
	}
}

// The personal Hot lead is not asked for a Hot request with `followed` or a non-empty `ids` (Node
// skips the lead for both), and is for an empty `ids` list.
func TestPersonalHotLeadSkipsPortedShapes(t *testing.T) {
	ports := modelfeed.Ports{IDs: true, Followed: true}
	for input, asked := range map[string]bool{
		`{"json":{"sort":"Hot","browsingLevel":1,"followed":true}}`: false,
		`{"json":{"sort":"Hot","browsingLevel":1,"ids":[5]}}`:       false,
		`{"json":{"sort":"Hot","browsingLevel":1,"ids":[]}}`:        true,
	} {
		flag := &stubUserFlag{}
		s := &Server{Models: &modelfeed.Deps{Config: modelfeed.Config{Ports: ports}}, PersonalHotLead: flag}
		ctx, r := leadRequest(t, input, leadViewer())
		req, user, err := s.prepareModelGetAllViewer(ctx, r)
		if err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		if err := s.personalHotLead(ctx, req, user); err != nil {
			t.Fatalf("%s: %v", input, err)
		}
		if got := len(flag.asked()) == 1; got != asked {
			t.Errorf("%s: flag asked %v, want %v", input, got, asked)
		}
	}
}
