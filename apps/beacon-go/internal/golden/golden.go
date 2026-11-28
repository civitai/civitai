// Package golden loads the golden fixtures (testdata/golden, written by gen.ts from the Node code)
// for the beacon, shadow and server tests. Only tests import it; the binary never does.
package golden

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/beacon-go/internal/auth"
	"github.com/civitai/civitai/apps/beacon-go/internal/beacon"
	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
)

// Dir is testdata/golden relative to a package directory under internal/.
var Dir = filepath.Join("..", "..", "testdata", "golden")

// Fixture is one golden case (testdata/golden/{ping,pulse,track-batch}/*.json, written by gen.ts from
// the Node code; see that file for where each expected value comes from).
type Fixture struct {
	Name     string `json:"name"`
	Endpoint string `json:"endpoint"`
	Request  struct {
		Method       string            `json:"method"`
		Target       string            `json:"target"`
		Headers      map[string]string `json:"headers"`
		Body         *string           `json:"body"`
		BodyHex      string            `json:"bodyHex"`
		BodyTemplate *struct {
			Prefix string `json:"prefix"`
			Repeat string `json:"repeat"`
			Count  int    `json:"count"`
			Suffix string `json:"suffix"`
		} `json:"bodyTemplate"`
	} `json:"request"`
	Session *struct {
		ID     int     `json:"id"`
		Tier   *string `json:"tier"`
		Cookie string  `json:"cookie"`
		Iat    float64 `json:"iat"`
	} `json:"session"`
	TrackerEnabled bool   `json:"trackerEnabled"`
	Fallback       string `json:"fallback"`
	Expect         struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    string            `json:"body"`
		Writes  []struct {
			Table  string `json:"table"`
			Body   string `json:"body"`
			Sha256 string `json:"sha256"`
			Length int    `json:"length"`
		} `json:"writes"`
	} `json:"expect"`
	Shadow string `json:"shadow"`
}

// GoldenNow is the fixed clock of the golden runs: an hour after the fixtures' fresh token was
// issued (gen.ts SIGNED_IN.iat), so only the deliberately old token is due a rolling refresh.
var GoldenNow = time.Unix(1_780_000_000+3600, 0)

// LoadFixtures reads every golden fixture under dir (testdata/golden).
func LoadFixtures(t testing.TB, dir string) []Fixture {
	t.Helper()
	var out []Fixture
	for _, ep := range []string{beacon.EndpointPing, beacon.EndpointPulse, beacon.EndpointTrackBatch} {
		files, err := filepath.Glob(filepath.Join(dir, ep, "*.json"))
		if err != nil {
			t.Fatal(err)
		}
		sort.Strings(files)
		for _, f := range files {
			b, err := os.ReadFile(f) //nolint:gosec // G304: a fixture path from a glob under testdata
			if err != nil {
				t.Fatal(err)
			}
			var fx Fixture
			if err := json.Unmarshal(b, &fx); err != nil {
				t.Fatalf("%s: %v", f, err)
			}
			out = append(out, fx)
		}
	}
	return out
}

// BodyBytes is the fixture's raw request body.
func (fx *Fixture) BodyBytes(t testing.TB) []byte {
	t.Helper()
	switch {
	case fx.Request.BodyTemplate != nil:
		b := fx.Request.BodyTemplate
		return []byte(b.Prefix + strings.Repeat(b.Repeat, b.Count) + b.Suffix)
	case fx.Request.Body != nil:
		return []byte(*fx.Request.Body)
	default:
		b, err := hex.DecodeString(fx.Request.BodyHex)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
}

// latin1Bytes turns a JS string of code units below U+0100 back into the header bytes Node read it
// from (the inverse of jsvalue.Latin1).
func latin1Bytes(t testing.TB, s string) string {
	t.Helper()
	b := make([]byte, 0, len(s))
	for _, r := range s {
		if r > 0xFF {
			t.Fatalf("header value %q is not latin-1", s)
		}
		b = append(b, byte(r)) //nolint:gosec // G115: r <= 0xFF, checked above
	}
	return string(b)
}

// HTTPRequest is the fixture as the Go server would receive it.
func (fx *Fixture) HTTPRequest(t testing.TB) (*http.Request, []byte) {
	t.Helper()
	body := fx.BodyBytes(t)
	r := httptest.NewRequestWithContext(context.Background(), fx.Request.Method, fx.Request.Target, bytes.NewReader(body))
	r.Host = ""
	for k, v := range fx.Request.Headers {
		if k == "host" {
			r.Host = latin1Bytes(t, v)
			continue
		}
		r.Header[http.CanonicalHeaderKey(k)] = []string{latin1Bytes(t, v)}
	}
	return r, body
}

// stubSessions answers the fixture's session for a cookie-carrying request, and falls back on an API
// credential as auth.Resolver does (its own behaviour is pinned in internal/auth).
type stubSessions struct{ user *auth.SessionUser }

func (s stubSessions) Resolve(_ context.Context, r *http.Request) (*auth.SessionUser, error) {
	if r.Header.Get("Authorization") != "" || r.URL.Query().Get("token") != "" {
		return nil, fallback.New("bearer-token")
	}
	return s.user, nil
}

// Engine is the engine a fixture runs on.
func (fx *Fixture) Engine() *beacon.Engine {
	var user *auth.SessionUser
	if s := fx.Session; s != nil {
		user = &auth.SessionUser{
			ID:         s.ID,
			Claims:     &auth.Claims{Iat: json.RawMessage(strconv.FormatFloat(s.Iat, 'f', -1, 64))},
			CookieName: s.Cookie,
		}
		if s.Tier != nil {
			user.Tier, user.TierSet = *s.Tier, true
		}
	}
	return &beacon.Engine{
		Sessions:       stubSessions{user: user},
		TrackerEnabled: fx.TrackerEnabled,
		HubOrigin:      "https://auth.example.test",
		UpdateAgeMs:    86_400_000,
		ModeFor:        func(string) (string, bool) { return "shared", true },
		Now:            func() time.Time { return GoldenNow },
	}
}

// CheckOutcome compares an outcome with the fixture's expected Node answer.
func (fx *Fixture) CheckOutcome(t testing.TB, out beacon.Outcome) {
	t.Helper()
	e := fx.Expect
	if out.Response.Status != e.Status {
		t.Errorf("status %d, Node %d", out.Response.Status, e.Status)
	}
	for _, name := range beacon.ComparedHeaders {
		got, gok := out.Response.Get(name)
		want, wok := e.Headers[name]
		if gok != wok || got != want {
			t.Errorf("header %s: got %q (%v), Node %q (%v)", name, got, gok, want, wok)
		}
	}
	for name := range e.Headers {
		found := false
		for _, c := range beacon.ComparedHeaders {
			found = found || c == name
		}
		if !found {
			t.Errorf("Node set %s, which beacon.ComparedHeaders does not cover", name)
		}
	}
	if out.Response.Body != e.Body {
		t.Errorf("body %q, Node %q", out.Response.Body, e.Body)
	}
	if len(out.Writes) != len(e.Writes) {
		t.Fatalf("%d writes, Node %d", len(out.Writes), len(e.Writes))
	}
	for i, w := range out.Writes {
		ew := e.Writes[i]
		if w.Table != ew.Table {
			t.Errorf("write %d table %s, Node %s", i, w.Table, ew.Table)
		}
		if ew.Sha256 != "" {
			sum := sha256.Sum256(w.Body)
			if hex.EncodeToString(sum[:]) != ew.Sha256 || len(w.Body) != ew.Length {
				t.Errorf("write %d: %d bytes sha256 %x, Node %d bytes %s", i, len(w.Body), sum, ew.Length, ew.Sha256)
			}
			continue
		}
		if string(w.Body) != ew.Body {
			t.Errorf("write %d\n got  %s\n node %s", i, w.Body, ew.Body)
		}
	}
}
