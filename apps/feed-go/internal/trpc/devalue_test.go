package trpc

import (
	"context"
	"net/http"
	"testing"
)

// The capability check against node-semver 7's own answers: each want below is what
// `semver.valid(v) ? semver.gte(semver.valid(v), '5.0.2080') : false` printed for v in the repo's
// node_modules (isPhase1CapableClientVersion), not a reading of the Go code.
func TestPhase1CapableVersionMatchesNodeSemver(t *testing.T) {
	for v, want := range map[string]bool{
		"5.0.2080": true, "5.0.2079": false, "5.0.2081": true, "5.1.537": true, "6.0.0": true,
		"4.99.99999": false, "5.0.2080-beta": false, "5.0.2081-beta": true, "5.0.2080+build": true,
		"v5.0.2080": true, "V5.0.2080": false, "=5.0.2080": false, " 5.0.2081 ": true,
		"\t5.0.2081\n": true, "\ufeff5.0.2081": true, "\u00855.0.2081": false, "05.0.2081": false,
		"5.00.2081": false, "5.0.02081": false, "5.0": false, "5": false, "": false, "unknown": false,
		"5.0.2081.1": false, "5.0.2081-": false, "5.0.2081-01": false, "5.0.2081-0a": true,
		"5.0.2081-a.01": false, "5.0.2081+": false, "5.0.2081+a..b": false, "5.0.2081-a_b": false,
		"9007199254740991.0.0": true, "9007199254740992.0.0": false, "99999999999999999999.0.0": false,
		"5.0.2081, 5.0.2081": false, "5.0.2081-rc.1+b.2": true, "5.0.9007199254740991": true,
	} {
		if got := phase1CapableVersion(v); got != want {
			t.Errorf("phase1CapableVersion(%q) = %v, Node says %v", v, got, want)
		}
	}
	// MAX_LENGTH is checked on the untrimmed string: 257 characters are refused whatever they hold.
	long := "5.0.2081-" + string(make([]byte, 0))
	for len(long) < 257 {
		long += "a"
	}
	if phase1CapableVersion(long) {
		t.Errorf("a %d-character version is capable", len(long))
	}
	if !phase1CapableVersion(long[:256]) {
		t.Errorf("a 256-character version is not capable")
	}
}

func TestCanDecodeDevalueResponse(t *testing.T) {
	h := func(kv ...string) http.Header {
		out := http.Header{}
		for i := 0; i < len(kv); i += 2 {
			out.Add(kv[i], kv[i+1]) //nolint:gosec // G602: every call passes key, value pairs
		}
		return out
	}
	for name, c := range map[string]struct {
		h    http.Header
		want bool
	}{
		"web, current":            {h("x-client", "web", "x-client-version", "5.1.537"), true},
		"web, threshold":          {h("X-Client", "web", "X-Client-Version", "5.0.2080"), true},
		"web, older":              {h("x-client", "web", "x-client-version", "5.0.2079"), false},
		"web, no version":         {h("x-client", "web"), false},
		"web, unknown version":    {h("x-client", "web", "x-client-version", "unknown"), false},
		"no client":               {h("x-client-version", "5.1.537"), false},
		"other client":            {h("x-client", "app-sdk", "x-client-version", "5.1.537"), false},
		"client case":             {h("x-client", "Web", "x-client-version", "5.1.537"), false},
		"repeated client":         {h("x-client", "web", "x-client", "web", "x-client-version", "5.1.537"), false},
		"repeated version":        {h("x-client", "web", "x-client-version", "5.1.537", "x-client-version", "5.1.537"), false},
		"nothing":                 {h(), false},
		"web, prerelease of 2080": {h("x-client", "web", "x-client-version", "5.0.2080-rc.1"), false},
	} {
		if got := CanDecodeDevalueResponse(c.h); got != c.want {
			t.Errorf("%s: CanDecodeDevalueResponse = %v, want %v", name, got, c.want)
		}
	}
}

func TestWriteDevalueOn(t *testing.T) {
	for v, want := range map[string]bool{"true": true, "": false, "1": false, "TRUE": false, "True": false, " true": false, "true ": false, "yes": false} {
		if got := WriteDevalueOn(v); got != want {
			t.Errorf("WriteDevalueOn(%q) = %v, want %v", v, got, want)
		}
	}
}

// DevalueWrite: only a marked request, and never an edge-cacheable answer (pinResponseWriteToSuperjson).
func TestDevalueWrite(t *testing.T) {
	marked := WithDevalueWrite(context.Background())
	noEdge := &CacheTTL{Browser: 60, Edge: 0}
	for name, c := range map[string]struct {
		ctx  context.Context
		ttl  *CacheTTL
		want bool
	}{
		"marked, private":          {marked, nil, true},
		"marked, no edge TTL":      {marked, noEdge, true},
		"marked, edge-cacheable":   {marked, &SignedOutTTL, false},
		"unmarked, private":        {context.Background(), nil, false},
		"unmarked, edge-cacheable": {context.Background(), &SignedOutTTL, false},
	} {
		if got := DevalueWrite(c.ctx, c.ttl); got != c.want {
			t.Errorf("%s: DevalueWrite = %v, want %v", name, got, c.want)
		}
	}
	// EdgeCached is the condition ResultCacheControl's public header is written under.
	for _, ttl := range []*CacheTTL{nil, noEdge, &SignedOutTTL} {
		public := ResultCacheControl(ttl) != ResultCacheControl(nil)
		if EdgeCached(ttl) != public {
			t.Errorf("ttl %+v: EdgeCached %v, public Cache-Control %v", ttl, EdgeCached(ttl), public)
		}
	}
}
