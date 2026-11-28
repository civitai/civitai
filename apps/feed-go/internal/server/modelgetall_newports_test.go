package server

import (
	"context"
	"net/http"
	"net/url"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/browsing"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
)

// A verified crawler on model.getAll is not ported: any value of the verified-crawler header falls
// back (`verified-bot`), as on main, with every model.getAll port switched on, on a Node sample (shadow,
// probe) and on the public route, before the session is read and before any store is read
// (computeModelGetAll included). With the ports on, the input carries the two new ports' shapes, so
// the header check, not an input refusal, decides it (with them off such an input is refused first,
// as on main, so that case sends a plain one).
func TestModelGetAllVerifiedBotFallsBack(t *testing.T) {
	ctx := auth.WithResolved(context.Background(), nil, nil)
	const plain = `{"json":{"browsingLevel":31}}`
	const ported = `{"json":{"browsingLevel":31,"newCreators":true,"publishedFrom":"2026-06-01","publishedTo":"2026-06-02"}}`
	input := plain
	sampled := func(host, bot string) *http.Request {
		r, err := SyntheticModelGetAllRequest(ctx, ShadowRequest{Input: input, Headers: map[string]string{"host": host, verifiedBotHeader: bot}})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	public := func(host, bot string) *http.Request {
		r, err := http.NewRequestWithContext(ctx, http.MethodGet, "/api/trpc/"+ProcedureModelGetAll+"?input="+url.QueryEscape(input), nil)
		if err != nil {
			t.Fatal(err)
		}
		r.Host = host
		r.Header.Set(verifiedBotHeader, bot)
		return r
	}
	every := modelfeed.Ports{IDs: true, Followed: true, HidePaid: true, NewCreators: true, PublishedRange: true}
	for _, ports := range []modelfeed.Ports{{}, every} {
		input = plain
		if ports.NewCreators {
			input = ported
		}
		s := &Server{Models: &modelfeed.Deps{Config: modelfeed.Config{Ports: ports}}, Hosts: goldenHosts, HostPrimaries: goldenPrimaries}
		for _, host := range []string{"blue.example.test", "red.example.test", "green.example.test"} {
			for _, bot := range []string{"googlebot", "bingbot", "1"} {
				for route, r := range map[string]*http.Request{"sample": sampled(host, bot), "public": public(host, bot)} {
					if _, _, err := s.prepareModelGetAllViewer(ctx, r); fallback.Reason(err) != "verified-bot" {
						t.Errorf("ports %+v, %s %s %q: prepare %v (%q), want verified-bot", ports, route, host, bot, err, fallback.Reason(err))
					}
					if _, err := s.computeModelGetAll(ctx, r); fallback.Reason(err) != "verified-bot" {
						t.Errorf("ports %+v, %s %s %q: compute %v (%q), want verified-bot", ports, route, host, bot, err, fallback.Reason(err))
					}
				}
			}
		}
	}
	// The control: the same request with no header is prepared (the header alone refuses it).
	input = ported
	s := &Server{Models: &modelfeed.Deps{Config: modelfeed.Config{Ports: every}}, Hosts: goldenHosts, HostPrimaries: goldenPrimaries}
	r, err := SyntheticModelGetAllRequest(ctx, ShadowRequest{Input: input, Headers: map[string]string{"host": "red.example.test"}})
	if err != nil {
		t.Fatal(err)
	}
	mreq, _, err := s.prepareModelGetAllViewer(ctx, r)
	if err != nil || mreq.BoardColor != "red" || !mreq.Input.NewCreators || mreq.Cap != browsing.PublicLevels {
		t.Errorf("no header: %v (%q), board %q newCreators %v cap %d; want prepared, red, true, %d",
			err, fallback.Reason(err), mreq.BoardColor, mreq.Input.NewCreators, mreq.Cap, browsing.PublicLevels)
	}
}

// goldenNewPortFixtures are the served model-getall fixtures of the `newCreators` and published-range
// ports, each with the reason the same request falls back with while its switch
// is off.
var goldenNewPortFixtures = map[string]string{
	"new-creators-signed-out":            "input-newCreators",
	"new-creators-red-board":             "input-newCreators",
	"new-creators-empty-board":           "input-newCreators",
	"published-range-signed-out":         "input-publishedFrom",
	"published-range-split-cursor-types": "input-publishedFrom",
}

// Each new port's switch decides it: on (the fixture's config), the request is Node's answer (the
// golden harness compares it); off, the same request is the fallback it always was.
func TestModelGetAllNewPortsSwitch(t *testing.T) {
	for name, offReason := range goldenNewPortFixtures {
		t.Run(name, func(t *testing.T) {
			fx := goldenLoad(t, goldenDir+"/model-getall/"+name+".json")
			if !fx.Config.ServeInputNewCreators && !fx.Config.ServePublishedRange {
				t.Fatal("a port fixture must switch its port on")
			}
			goldenRunModels(t, fx)
			off := *fx
			off.Config.ServeInputNewCreators, off.Config.ServePublishedRange = false, false
			off.Expect.Fallback = offReason
			if _, err := goldenComputeModels(t, &off); fallback.Reason(err) != offReason {
				t.Fatalf("switch off: %v (reason %q), want %q", err, fallback.Reason(err), offReason)
			}
		})
	}
}
