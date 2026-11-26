package evalharness

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// hostAccounts writes an accounts file whose member-mature account has a default token (unless
// def is "") and one token per host in perHost, and owns the API key; every other member role gets a
// default token. It returns the file's path.
func hostAccounts(t *testing.T, def string, perHost map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	write := func(name, tok string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(tok+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	f := AccountsFile{SessionCookie: "eval-session"}
	for _, role := range MemberRoles {
		spec := testIdentities[role]
		if role != RoleMature {
			spec.SessionTokenFile = write(role+".token", fakeJWT(t, farExpiry.Unix()))
			f.Accounts = append(f.Accounts, spec)
			continue
		}
		if def != "" {
			spec.SessionTokenFile = write("mature.token", def)
		}
		if len(perHost) > 0 {
			spec.SessionTokenFiles = map[string]string{}
			i := 0
			for h, tok := range perHost {
				i++
				spec.SessionTokenFiles[h] = write("mature-"+strconv.Itoa(i)+".token", tok)
			}
		}
		f.Accounts = append(f.Accounts, spec)
	}
	f.APIKey = &APIKeySpec{KeyFile: write("api.key", testAPIKey), Role: RoleMature}
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	return write("accounts.json", string(b))
}

// fakeJWTSub is fakeJWT with a distinct sub, so tokens with one exp are still distinct strings.
func fakeJWTSub(t *testing.T, sub string, exp time.Time) string {
	t.Helper()
	tok := fakeJWT(t, exp.Unix())
	parts := strings.Split(tok, ".")
	return parts[0] + "." + parts[1] + "." + sub
}

func TestResolvePicksTheSessionForTheCaseHost(t *testing.T) {
	def := fakeJWTSub(t, "ZGVm", farExpiry)
	red := fakeJWTSub(t, "cmVk", farExpiry)
	eu := fakeJWTSub(t, "ZXU", farExpiry)
	a, err := LoadAccounts(hostAccounts(t, def, map[string]string{"red.example": red, "eu.red.example": eu}), testNow, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	m := Mapping{Role: RoleMature, Cookie: true}
	for host, want := range map[string]string{
		"red.example":        red,
		"RED.EXAMPLE:443":    red, // case and port do not matter
		"red.example.":       red, // nor a trailing dot
		"www.red.example":    red, // a subdomain of a key
		"eu.red.example":     eu,  // the longest key wins
		"a.eu.red.example":   eu,
		"site.example":       def, // no key: the default token
		"notred.example":     def, // a suffix match needs a label boundary
		"red.example.evil.x": def,
		"":                   def,
	} {
		c, why := a.Resolve(m, host)
		if why != "" || c.Cookie != "eval-session="+want {
			t.Errorf("host %q: cookie for %q (why %q), want the token for %q", host, tokenName(c.Cookie, def, red, eu), why, tokenName("eval-session="+want, def, red, eu))
		}
	}
	// The API key's owner's cookie, sent with the key, follows the case host too.
	key := Mapping{APIKey: true, Header: true, Cookie: true}
	for host, want := range map[string]string{"red.example": red, "site.example": def} {
		c, why := a.Resolve(key, host)
		if why != "" || c.ViewerUsed != "apikey:"+RoleMature || c.Bearer != testAPIKey || c.Cookie != "eval-session="+want {
			t.Errorf("api key on %q: viewer %q bearer set %v cookie %q (why %q)", host, c.ViewerUsed, c.Bearer == testAPIKey,
				tokenName(c.Cookie, def, red, eu), why)
		}
	}
	// The longest key wins when it also sorts LAST (a first-match would pick the shorter one).
	www := fakeJWTSub(t, "d3d3", farExpiry)
	b, err := LoadAccounts(hostAccounts(t, def, map[string]string{"red.example": red, "www.red.example": www}), testNow, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	for host, want := range map[string]string{"a.www.red.example": www, "www.red.example": www, "b.red.example": red} {
		if c, why := b.Resolve(m, host); why != "" || c.Cookie != "eval-session="+want {
			t.Errorf("host %q: got %q (why %q)", host, tokenName(c.Cookie, def, red, www), why)
		}
	}
}

// tokenName names which test token a cookie carries, so a failure never prints one.
func tokenName(cookie, def, red, eu string) string {
	switch strings.TrimPrefix(cookie, "eval-session=") {
	case def:
		return "default"
	case red:
		return "red"
	case eu:
		return "eu"
	case "":
		return "none"
	}
	return "other"
}

func TestResolveWithNoDefaultTokenIsNotReplayableOffItsHosts(t *testing.T) {
	red := fakeJWTSub(t, "cmVk", farExpiry)
	a, err := LoadAccounts(hostAccounts(t, "", map[string]string{"red.example": red}), testNow, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if c, why := a.Resolve(Mapping{Role: RoleMature, Cookie: true}, "red.example"); why != "" || c.Cookie != "eval-session="+red {
		t.Fatalf("on its host: %q", why)
	}
	for _, host := range []string{"site.example", ""} {
		if _, why := a.Resolve(Mapping{Role: RoleMature, Cookie: true}, host); why != "no-session:member-mature" {
			t.Errorf("host %q: why %q, want no-session:member-mature", host, why)
		}
	}
}

func TestPerHostExpiryIsPerToken(t *testing.T) {
	def := fakeJWTSub(t, "ZGVm", farExpiry)
	past := testNow.Add(-time.Hour)
	soon := testNow.Add(2 * 24 * time.Hour)
	red := fakeJWTSub(t, "cmVk", past)
	eu := fakeJWTSub(t, "ZXU", soon)
	var warn bytes.Buffer
	a, err := LoadAccounts(hostAccounts(t, def, map[string]string{"red.example": red, "eu.example": eu}), testNow, &warn)
	if err != nil {
		t.Fatal(err)
	}
	acc := a.Role(RoleMature)
	if acc.Expired || !acc.Expires.Equal(past) {
		t.Fatalf("account Expired %v Expires %v: want not expired, earliest exp %v", acc.Expired, acc.Expires, past)
	}
	if _, why := a.Resolve(Mapping{Role: RoleMature, Cookie: true}, "red.example"); why != "account-expired:member-mature" {
		t.Errorf("expired host: %q", why)
	}
	if _, why := a.Resolve(Mapping{Role: RoleMature, Cookie: true}, "site.example"); why != "" {
		t.Errorf("default host: %q", why)
	}
	want := []AccountNote{
		{Role: RoleMature, Host: "eu.example", Expires: "2026-11-28T04:00:00Z", State: AccountExpiring},
		{Role: RoleMature, Host: "red.example", Expires: "2026-11-26T03:00:00Z", State: AccountExpired},
	}
	if got := a.Notes(); !reflect.DeepEqual(got, want) {
		t.Fatalf("notes %+v\nwant %+v", got, want)
	}
	w := warn.String()
	for _, line := range []string{
		"account member-mature (eu.example): session token expires 2026-11-28T04:00:00Z (in 2.0 days)",
		"account member-mature (red.example): session token EXPIRED at 2026-11-26T03:00:00Z",
	} {
		if !strings.Contains(w, line) {
			t.Errorf("warning %q missing from %q", line, w)
		}
	}
	for _, secret := range []string{def, red, eu} {
		if strings.Contains(w, secret) {
			t.Fatal("a warning holds a token")
		}
	}
	// Every token expired: the account is Expired.
	b, err := LoadAccounts(hostAccounts(t, fakeJWTSub(t, "ZGVm", past), map[string]string{"red.example": red}), testNow, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if !b.Role(RoleMature).Expired {
		t.Error("all tokens expired: account not Expired")
	}
}

func TestLoadAccountsRefusesABadHostMap(t *testing.T) {
	tok := fakeJWT(t, farExpiry.Unix())
	for name, perHost := range map[string]map[string]string{
		"upper case":   {"Red.example": tok},
		"a port":       {"red.example:443": tok},
		"one label":    {"localhost": tok},
		"a scheme":     {"https://red.example": tok},
		"a wildcard":   {"*.red.example": tok},
		"empty key":    {"": tok},
		"not a JWS":    {"red.example": "opaque"},
		"empty token":  {"red.example": " "},
		"trailing dot": {"red.example.": tok},
	} {
		if _, err := LoadAccounts(hostAccounts(t, "", perHost), testNow, &bytes.Buffer{}); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	// Neither field: refused, named.
	if _, err := LoadAccounts(hostAccounts(t, "", nil), testNow, &bytes.Buffer{}); err == nil ||
		!strings.Contains(err.Error(), "role member-mature: session token: no file named") {
		t.Errorf("no token file: %v", err)
	}
	// Positive control: the same builder with a good map loads.
	if _, err := LoadAccounts(hostAccounts(t, "", map[string]string{"red.example": tok}), testNow, &bytes.Buffer{}); err != nil {
		t.Errorf("good map: %v", err)
	}
}

// TestRunReplaysEachCaseWithItsHostsToken is the seam: two cases differing only in their stored
// Host reach the arms with that host's session cookie.
func TestRunReplaysEachCaseWithItsHostsToken(t *testing.T) {
	def := fakeJWTSub(t, "ZGVm", farExpiry)
	red := fakeJWTSub(t, "cmVk", farExpiry)
	accounts, err := LoadAccounts(hostAccounts(t, def, map[string]string{"red.example": red}), time.Now(), &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	seen := map[string]map[string]bool{} // host -> token names seen
	arm := func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		if seen[r.Host] == nil {
			seen[r.Host] = map[string]bool{}
		}
		seen[r.Host][tokenName(r.Header.Get("Cookie"), def, red, "")] = true
		mu.Unlock()
		_, _ = w.Write([]byte(`{"id":1}`))
	}
	nodeSrv := httptest.NewServer(http.HandlerFunc(arm))
	defer nodeSrv.Close()
	goSrv := httptest.NewServer(http.HandlerFunc(arm))
	defer goSrv.Close()
	mature := evalcorpus.ViewerDescriptor{Class: evalcorpus.ViewerUser, ShowNsfw: true}
	mk := func(id uint64, host string) Case {
		return Case{ID: id, Endpoint: evalcorpus.EndpointV1ModelsID, Sig: id + 0x5000, SigText: `{"v":1}`,
			Request: evalcapture.StoredRequest{Path: "/api/v1/models/1", Headers: map[string]string{"host": host},
				Credential: "session", Viewer: mature}}
	}
	store := &memStore{cases: map[string][]Case{evalcorpus.EndpointV1ModelsID: {mk(0x2101, "site.example"), mk(0x2102, "red.example")}}}
	cfg := RunConfig{NodeURL: nodeSrv.URL, GoURL: goSrv.URL, ForceWindow: true, AllowNoHealth: true, RPS: 1000,
		CallTimeout: time.Second, Lookback: time.Hour, PerEndpointCap: 10, Log: &bytes.Buffer{},
		NodeImage: "n", GoImage: "g", SnapshotID: "s"}
	if _, err := Run(context.Background(), cfg, accounts, store); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	want := map[string]map[string]bool{"site.example": {"default": true}, "red.example": {"red": true}}
	if !reflect.DeepEqual(seen, want) {
		t.Fatalf("cookies by host %v, want %v", seen, want)
	}
	for _, r := range store.results {
		if r.ViewerUsed != RoleMature {
			t.Errorf("case %x: viewer %q (%s %s)", r.CaseID, r.ViewerUsed, r.Verdict, r.Reason)
		}
	}
}

func TestIndexShowsEachNotesHost(t *testing.T) {
	notes := []AccountNote{
		{Role: RoleMature, Expires: "2026-11-28T04:00:00Z", State: AccountExpiring},
		{Role: RoleMature, Host: "red.example", Expires: "2026-11-28T04:00:00Z", State: AccountExpired},
		{Role: RoleOwner, Host: "Bad Host<script>", State: AccountNoExp},
	}
	rep, err := Aggregate(Facts{Runs: []RunFacts{{RunID: "r1", Started: testNow, EndReason: "done", Accounts: notes}}}, nil, "feed-eval")
	if err != nil {
		t.Fatal(err)
	}
	hosts := make([]string, 0, len(rep.Index.Accounts))
	for _, r := range rep.Index.Accounts {
		hosts = append(hosts, r.Host)
	}
	if want := []string{"-", "red.example", Redacted}; !reflect.DeepEqual(hosts, want) {
		t.Fatalf("hosts %q, want %q", hosts, want)
	}
	_, pages, err := Render(rep, nil)
	if err != nil {
		t.Fatal(err)
	}
	html := pages["feed-eval"].HTML
	if !strings.Contains(html, "<td>member-mature</td><td>red.example</td>") || strings.Contains(html, "<script>") {
		t.Fatalf("index html: %q", html)
	}
}
