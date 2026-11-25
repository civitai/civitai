package server

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
	"github.com/civitai/civitai/apps/feed-go/internal/fallback"
)

// The `user-hubs` gate reads the flag as createContext's feature flags do: the session user's id and
// buildFliptContext(user) (a banned one too), or 'anonymous' with the signed-out context, the
// deployment id added when set. Off is Node's UNAUTHORIZED; an error or no reader never serves.
func TestUserHubsGate(t *testing.T) {
	tier := "gold"
	viewer := &auth.SessionUser{ID: 4101, IsModerator: true, Tier: &tier, IsEarlyAdopter: true, AppBuilderApproved: true, Onboarding: 16}
	banned := &auth.SessionUser{ID: 4102, Banned: true}
	for _, c := range []struct {
		name       string
		user       *auth.SessionUser
		deployment string
		wantEntity string
		wantCtx    map[string]string
	}{
		{"signed in", viewer, "", "4101", map[string]string{
			"userId": "4101", "isModerator": "true", "tier": "gold", "isLoggedIn": "true", "isMember": "true",
			"isEarlyAdopter": "true", "appBuilderApproved": "true", "isInCreatorProgram": "true",
		}},
		{"banned", banned, "", "4102", map[string]string{
			"userId": "4102", "isModerator": "false", "tier": "free", "isLoggedIn": "true", "isMember": "false",
			"isEarlyAdopter": "false", "appBuilderApproved": "false", "isInCreatorProgram": "false",
		}},
		{"signed out", nil, "", "anonymous", map[string]string{"isLoggedIn": "false"}},
		{"signed out, a deployment", nil, "canary-7", "anonymous", map[string]string{"isLoggedIn": "false", "deploymentId": "canary-7"}},
	} {
		flag := &stubUserFlag{on: true}
		s := &Server{UserHubs: flag, FliptDeploymentID: c.deployment}
		if err := s.userHubs(context.Background(), c.user); err != nil {
			t.Fatalf("%s: on: %v, want served", c.name, err)
		}
		if want := []stubFlagCall{{c.wantEntity, c.wantCtx}}; !reflect.DeepEqual(flag.asked(), want) {
			t.Errorf("%s: asked %+v, want %+v", c.name, flag.asked(), want)
		}
	}
	for _, c := range []struct {
		name   string
		reader UserFlagReader
		want   string
	}{
		{"off", &stubUserFlag{on: false}, ReasonHubFlagOff},
		{"a failed read", &stubUserFlag{on: true, err: errors.New("flipt down")}, ReasonHubFlagUnknown},
		{"no reader", nil, ReasonHubFlagUnknown},
	} {
		s := &Server{UserHubs: c.reader}
		if err := s.userHubs(context.Background(), viewer); fallback.Reason(err) != c.want {
			t.Errorf("%s: %v, want %s", c.name, err, c.want)
		}
	}
	if ReasonHubFlagOff != "infinite-hub-flag-off" || ReasonHubFlagUnknown != "infinite-hub-flag-unknown" || UserHubsFlag != "user-hubs" {
		t.Fatalf("reasons %q %q flag %q", ReasonHubFlagOff, ReasonHubFlagUnknown, UserHubsFlag)
	}
}

// The gate is read only for a non-zero `hubId`, after the input is parsed: a request without a hub
// never asks Flipt, and a hub request the flag is off for falls back before anything is computed.
func TestUserHubsGateOnlyForAHub(t *testing.T) {
	fx := goldenLoad(t, filepath.Join(goldenDir, "infinite", "hub-id-zero.json"))
	env := goldenSetup(t, fx)
	flag := &stubUserFlag{on: false}
	env.server.UserHubs = flag
	r, err := SyntheticInfiniteRequest(context.Background(), ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.server.computeInfinite(context.Background(), r); err != nil {
		t.Fatalf("hubId 0 with the flag off: %v, want served (no hub, no gate)", err)
	}
	if n := len(flag.asked()); n != 0 {
		t.Fatalf("hubId 0: the flag was read %d times, want 0", n)
	}
	fx = goldenLoad(t, filepath.Join(goldenDir, "infinite", "hub-public-signed-out.json"))
	env = goldenSetup(t, fx)
	env.server.UserHubs = flag
	r, err = SyntheticInfiniteRequest(context.Background(), ShadowRequest{Input: fx.Request.Input, Headers: env.headers})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.server.computeInfinite(context.Background(), r); fallback.Reason(err) != ReasonHubFlagOff {
		t.Fatalf("a hub with the flag off: %v, want %s", err, ReasonHubFlagOff)
	}
	if n := len(flag.asked()); n != 1 {
		t.Fatalf("a hub: the flag was read %d times, want 1", n)
	}
}
