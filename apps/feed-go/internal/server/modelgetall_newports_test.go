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

// The verified crawler on model.getAll, as image.getInfinite reads it (verifiedCrawler). Off (the
// default), any value of the header is the `verified-bot` fallback, as before. On, a Node sample's
// `googlebot` / `bingbot` is a crawler: signed in for the cap where mature content is allowed
// (uncapped on blue and red), signed out on green; any other value is no crawler (a signed-out
// visitor); and on the public route the header is read as absent (the app's policy strips it from
// every user agent that reaches this service). The request carries its board color either way.
func TestPrepareModelGetAllVerifiedBot(t *testing.T) {
	ctx := auth.WithResolved(context.Background(), nil, nil)
	sampled := func(host, bot string) *http.Request {
		h := map[string]string{"host": host}
		if bot != "" {
			h[verifiedBotHeader] = bot
		}
		r, err := SyntheticModelGetAllRequest(ctx, ShadowRequest{Input: `{"json":{"browsingLevel":31}}`, Headers: h})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}
	public := func(host, bot string) *http.Request {
		u := "/api/trpc/" + ProcedureModelGetAll + "?input=" + url.QueryEscape(`{"json":{"browsingLevel":31}}`)
		r, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			t.Fatal(err)
		}
		r.Host = host
		r.Header.Set(verifiedBotHeader, bot)
		return r
	}
	off := &Server{Models: &modelfeed.Deps{}, Hosts: goldenHosts, HostPrimaries: goldenPrimaries}
	for _, bot := range []string{"googlebot", "bingbot", "1"} {
		if _, _, err := off.prepareModelGetAllViewer(ctx, sampled("blue.example.test", bot)); fallback.Reason(err) != "verified-bot" {
			t.Errorf("off, %q: %v (%q), want verified-bot", bot, err, fallback.Reason(err))
		}
	}
	on := &Server{Models: &modelfeed.Deps{Config: modelfeed.Config{Ports: modelfeed.Ports{VerifiedBot: true}}},
		Hosts: goldenHosts, HostPrimaries: goldenPrimaries}
	for _, c := range []struct {
		name    string
		r       *http.Request
		crawler bool
		cap     int
		board   string
	}{
		{"googlebot on blue", sampled("blue.example.test", "googlebot"), true, 0, "blue"},
		{"bingbot on red", sampled("red.example.test", "bingbot"), true, 0, "red"},
		{"bingbot on green", sampled("green.example.test", "bingbot"), true, browsing.PublicLevels, "green"},
		{"not a crawler's value", sampled("blue.example.test", "1"), false, browsing.PublicLevels, "blue"},
		{"no header", sampled("blue.example.test", ""), false, browsing.PublicLevels, "blue"},
		{"the public route", public("blue.example.test", "googlebot"), false, browsing.PublicLevels, "blue"},
	} {
		mreq, user, err := on.prepareModelGetAllViewer(ctx, c.r)
		if err != nil {
			t.Fatalf("on, %s: %v (%q)", c.name, err, fallback.Reason(err))
		}
		if mreq.Crawler != c.crawler || mreq.Cap != c.cap || mreq.Viewer != nil || user != nil || mreq.BoardColor != c.board {
			t.Errorf("on, %s: crawler %v cap %d viewer %v board %q, want %v %d none %q",
				c.name, mreq.Crawler, mreq.Cap, mreq.Viewer, mreq.BoardColor, c.crawler, c.cap, c.board)
		}
	}
}

// goldenNewPortFixtures are the served model-getall fixtures of the verified-crawler, `newCreators`
// and published-range ports, each with the reason the same request falls back with while its switch
// is off.
var goldenNewPortFixtures = map[string]string{
	"verified-bot-nsfw-host":             "verified-bot",
	"verified-bot-sfw-host":              "verified-bot",
	"verified-bot-header-not-a-crawler":  "verified-bot",
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
			if !fx.Config.ServeVerifiedBot && !fx.Config.ServeInputNewCreators && !fx.Config.ServePublishedRange {
				t.Fatal("a port fixture must switch its port on")
			}
			goldenRunModels(t, fx)
			off := *fx
			off.Config.ServeVerifiedBot, off.Config.ServeInputNewCreators, off.Config.ServePublishedRange = false, false, false
			off.Expect.Fallback = offReason
			if _, err := goldenComputeModels(t, &off); fallback.Reason(err) != offReason {
				t.Fatalf("switch off: %v (reason %q), want %q", err, fallback.Reason(err), offReason)
			}
		})
	}
}
