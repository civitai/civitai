package server

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"reflect"
	"sync"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
	"github.com/civitai/civitai/apps/feed-go/internal/flipt"
	"github.com/civitai/civitai/apps/feed-go/internal/modelfeed"
)

// stubUserFlag answers every read with on/err and records each (entity id, context) it was asked.
type stubUserFlag struct {
	on  bool
	err error

	mu    sync.Mutex
	calls []stubFlagCall
}

type stubFlagCall struct {
	entityID string
	ctx      map[string]string
}

func (f *stubUserFlag) Enabled(_ context.Context, entityID string, evalCtx map[string]string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, stubFlagCall{entityID, evalCtx})
	return f.on, f.err
}

func (f *stubUserFlag) asked() []stubFlagCall {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]stubFlagCall(nil), f.calls...)
}

// leadRequest is a model.getAll request for input, with user resolved (nil: signed out).
func leadRequest(t *testing.T, input string, user *auth.SessionUser) (context.Context, *http.Request) {
	t.Helper()
	ctx := auth.WithResolved(context.Background(), user, nil)
	r, err := SyntheticModelGetAllRequest(ctx, ShadowRequest{Input: input, Headers: map[string]string{"host": "civitai.example"}})
	if err != nil {
		t.Fatal(err)
	}
	return ctx, r
}

// leadViewer is a signed-in session user whose every targeting property differs from the defaults,
// so a context built from the wrong field (or a constant) shows.
func leadViewer() *auth.SessionUser {
	tier := "gold"
	return &auth.SessionUser{ID: 4101, Username: "lead_viewer", IsModerator: true, Tier: &tier, IsEarlyAdopter: true,
		AppBuilderApproved: true, Onboarding: 1 | 16 | 64}
}

const leadHotPage1 = `{"json":{"sort":"Hot","period":"Week","limit":20,"browsingLevel":3}}`

// A viewer the flag is on for, on signed-in Hot page 1, falls back with the lead's reason before
// anything is computed; the flag is read once, with the user id as the entity and Node's
// buildFliptContext(user) as the context.
func TestPersonalHotLeadFlaggedFallsBack(t *testing.T) {
	flag := &stubUserFlag{on: true}
	s := &Server{Models: &modelfeed.Deps{}, PersonalHotLead: flag, FliptDeploymentID: "dep-31"}
	ctx, r := leadRequest(t, leadHotPage1, leadViewer())
	_, err := s.computeModelGetAll(ctx, r)
	if got := fallback.Reason(err); got != ReasonPersonalHotLead {
		t.Fatalf("flagged: reason %q (%v), want %q", got, err, ReasonPersonalHotLead)
	}
	want := []stubFlagCall{{"4101", map[string]string{
		"userId": "4101", "isModerator": "true", "tier": "gold", "isLoggedIn": "true", "isMember": "true",
		"isEarlyAdopter": "true", "appBuilderApproved": "true", "isInCreatorProgram": "true", "deploymentId": "dep-31",
	}}}
	if got := flag.asked(); !reflect.DeepEqual(got, want) {
		t.Fatalf("flag asked %v, want %v", got, want)
	}
}

// The flag unreadable (an error, Flipt not configured) falls back with the unknown reason: a viewer
// who may be in the cohort is never served the page without the lead.
func TestPersonalHotLeadUnknownFallsBack(t *testing.T) {
	for name, s := range map[string]*Server{
		"flipt error":   {Models: &modelfeed.Deps{}, PersonalHotLead: &stubUserFlag{err: errors.New("flipt: personal-hot-lead: http 503")}},
		"backing off":   {Models: &modelfeed.Deps{}, PersonalHotLead: &stubUserFlag{err: flipt.ErrBackoff}},
		"not found":     {Models: &modelfeed.Deps{}, PersonalHotLead: &stubUserFlag{err: flipt.ErrFlagNotFound}},
		"no flipt read": {Models: &modelfeed.Deps{}},
	} {
		ctx, r := leadRequest(t, leadHotPage1, leadViewer())
		_, err := s.computeModelGetAll(ctx, r)
		if got := fallback.Reason(err); got != ReasonPersonalHotLeadUnknown {
			t.Errorf("%s: reason %q (%v), want %q", name, got, err, ReasonPersonalHotLeadUnknown)
		}
	}
}

// Every request Node would not lead is never asked about and passes the gate: a later page, another
// sort (the schema default included), signed out, banned, and each input that turns the lead off in
// getPersonalLeadIdsForFeed. The flag is on, so a request that wrongly reached it would fall back.
func TestPersonalHotLeadNotEvaluated(t *testing.T) {
	banned := leadViewer()
	banned.Banned = true
	for _, c := range []struct {
		name, input string
		user        *auth.SessionUser
	}{
		{"page 2", `{"json":{"sort":"Hot","limit":20,"browsingLevel":3,"cursor":"812|7301"}}`, leadViewer()},
		{"newest", `{"json":{"sort":"Newest","limit":20,"browsingLevel":3}}`, leadViewer()},
		{"schema default sort", `{"json":{"limit":20,"browsingLevel":3}}`, leadViewer()},
		{"signed out", leadHotPage1, nil},
		{"banned", leadHotPage1, banned},
		{"username", `{"json":{"sort":"Hot","browsingLevel":3,"username":"creator_nine"}}`, leadViewer()},
		{"user", `{"json":{"sort":"Hot","browsingLevel":3,"user":"creator_ten"}}`, leadViewer()},
		{"collection", `{"json":{"sort":"Hot","browsingLevel":3,"collectionId":6203}}`, leadViewer()},
		{"favorites", `{"json":{"sort":"Hot","browsingLevel":3,"favorites":true}}`, leadViewer()},
		{"archived", `{"json":{"sort":"Hot","browsingLevel":3,"archived":true}}`, leadViewer()},
	} {
		flag := &stubUserFlag{on: true}
		s := &Server{Models: &modelfeed.Deps{}, PersonalHotLead: flag}
		ctx, r := leadRequest(t, c.input, c.user)
		req, user, err := s.prepareModelGetAllViewer(ctx, r)
		if err != nil {
			t.Fatalf("%s: prepare: %v", c.name, err)
		}
		if err := s.personalHotLead(ctx, req, user); err != nil {
			t.Errorf("%s: gate %v, want served", c.name, err)
		}
		if n := len(flag.asked()); n != 0 {
			t.Errorf("%s: flag asked %d times, want 0", c.name, n)
		}
	}
	// Positive control: the same gate and flag on Hot page 1 is asked and falls back.
	flag := &stubUserFlag{on: true}
	s := &Server{Models: &modelfeed.Deps{}, PersonalHotLead: flag}
	ctx, r := leadRequest(t, leadHotPage1, leadViewer())
	req, user, err := s.prepareModelGetAllViewer(ctx, r)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.personalHotLead(ctx, req, user); fallback.Reason(err) != ReasonPersonalHotLead || len(flag.asked()) != 1 {
		t.Fatalf("control: gate %v, asked %d, want %q once", err, len(flag.asked()), ReasonPersonalHotLead)
	}
}

// End to end over a golden fixture (signed-in Hot page 1, a session with `tier: null`): flag off, the
// page is computed and served after one read with the default-tier context; on, it falls back. Page 2
// of the same feed and the signed-out fixture are served without a read.
func TestPersonalHotLeadGolden(t *testing.T) {
	load := func(name string) *goldenFixture {
		return goldenLoad(t, filepath.Join(goldenDir, "model-getall", name+".json"))
	}
	run := func(fx *goldenFixture, flag *stubUserFlag) error {
		env := goldenSetupModels(t, fx)
		env.server.PersonalHotLead = flag
		ctx := context.Background()
		r, err := SyntheticModelGetAllRequest(ctx, ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
		if err != nil {
			t.Fatal(err)
		}
		c, err := env.server.computeModelGetAll(ctx, r)
		if err == nil {
			c.release()
		}
		return err
	}
	page1 := load("hot-official-pin-page1")
	off := &stubUserFlag{}
	if err := run(page1, off); err != nil {
		t.Fatalf("page 1, flag off: %v (reason %q), want served", err, fallback.Reason(err))
	}
	want := []stubFlagCall{{"1003", map[string]string{
		"userId": "1003", "isModerator": "false", "tier": "free", "isLoggedIn": "true", "isMember": "false",
		"isEarlyAdopter": "false", "appBuilderApproved": "false", "isInCreatorProgram": "false",
	}}}
	if got := off.asked(); !reflect.DeepEqual(got, want) {
		t.Fatalf("page 1, flag off: asked %v, want %v", got, want)
	}
	if err := run(page1, &stubUserFlag{on: true}); fallback.Reason(err) != ReasonPersonalHotLead {
		t.Fatalf("page 1, flag on: %v, want %q", err, ReasonPersonalHotLead)
	}
	for _, name := range []string{"hot-official-pin-page2", "hot-official-pin-signed-out"} {
		on := &stubUserFlag{on: true}
		if err := run(load(name), on); err != nil {
			t.Fatalf("%s: %v (reason %q), want served", name, err, fallback.Reason(err))
		}
		if n := len(on.asked()); n != 0 {
			t.Fatalf("%s: flag asked %d times, want 0", name, n)
		}
	}
}

// isInCreatorProgram is Flags.hasFlag(onboarding, 16) on JS's int32 bitwise result.
func TestPersonalHotLeadTargetCreatorProgram(t *testing.T) {
	for onboarding, want := range map[int]bool{16: true, 1 | 16 | 64: true, 15: false, 1 | 2 | 64: false, 0: false, 1<<32 | 16: false} {
		if got := personalHotLeadTarget(&auth.SessionUser{ID: 4101, Onboarding: onboarding}).InCreatorProgram; got != want {
			t.Errorf("onboarding %d: %v, want %v", onboarding, got, want)
		}
	}
}
