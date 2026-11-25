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
)

// cold-creator-memberships is served (Node's answer, Node's writes) with
// FEED_GO_GETALL_SERVE_MEMBERSHIP_MISS on, and the same request is the membership-miss fallback with
// it off.
func TestModelGetAllMembershipMissSwitch(t *testing.T) {
	fx := goldenLoad(t, filepath.Join(goldenDir, "model-getall", "cold-creator-memberships.json"))
	if !fx.Config.ServeMembershipMiss {
		t.Fatal("the fixture must switch the port on")
	}
	goldenRunModels(t, fx)
	off := *fx
	off.Config.ServeMembershipMiss = false
	off.Expect.Fallback = "membership-miss"
	if _, err := goldenComputeModels(t, &off); fallback.Reason(err) != "membership-miss" {
		t.Fatalf("switch off: %v (reason %q), want membership-miss", err, fallback.Reason(err))
	}
}

// The shadow computes the miss with the switch on (a `match` against Node's answer), and keeps the
// old fallback with it off (`unsupported`).
func TestModelGetAllMembershipMissShadow(t *testing.T) {
	for _, on := range []bool{true, false} {
		t.Run(map[bool]string{true: "on", false: "off"}[on], func(t *testing.T) {
			fx := goldenLoad(t, filepath.Join(goldenDir, "model-getall", "cold-creator-memberships.json"))
			node := fx.Expect.Envelope
			want := "match"
			if !on {
				c := *fx
				c.Config.ServeMembershipMiss = false
				c.Expect.Fallback = "membership-miss"
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
			if err := s.Close(context.Background()); err != nil {
				t.Fatal(err)
			}
		})
	}
}
