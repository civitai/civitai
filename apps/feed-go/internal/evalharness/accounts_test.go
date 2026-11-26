package evalharness

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcorpus"
)

// testNow is the instant the account tests load at; its hour is inside DefaultWindow.
var testNow = time.Date(2026, 11, 26, 4, 0, 0, 0, time.UTC)

// fakeJWT is an unsigned three-part token whose payload carries exp (nil: no exp claim). Its
// signature part is junk: TokenExpiry never verifies.
func fakeJWT(t *testing.T, exp any) string {
	t.Helper()
	claims := map[string]any{"sub": "7301"}
	if exp != nil {
		claims["exp"] = exp
	}
	p, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"ES256","typ":"JWT"}`)) + "." +
		base64.RawURLEncoding.EncodeToString(p) + ".c2lnbmF0dXJl"
}

// Distinct per role, and distinct from every constant the assertions name.
var testIdentities = map[string]AccountSpec{
	RoleDefault:  {Role: RoleDefault, UserID: 7101, Username: "evaldefault", SearchText: "search-default-q"},
	RoleMature:   {Role: RoleMature, UserID: 7201, Username: "evalmature"},
	RoleFiltered: {Role: RoleFiltered, UserID: 7401, Username: "evalfiltered"},
	RoleOwner:    {Role: RoleOwner, UserID: 7301, Username: "evalowner", CollectionID: 8402, SearchText: "search-owner-q"},
}

// testAPIKey is the read-only API key of the tests: its `+`, `/` and `=` must be escaped in a query.
const testAPIKey = "apikey+sec/9931=" //nolint:gosec // G101: a synthetic test key. gitleaks:allow

// farExpiry is the default token's exp: far past any wall clock a test runs at, so the run tests
// (which load at time.Now) never see it expire.
var farExpiry = time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC)

// writeAccounts writes the accounts file and its secret files under t.TempDir; tokens maps a role to
// its session token (a role absent from it gets one expiring at farExpiry).
func writeAccounts(t *testing.T, tokens map[string]string, apiKeyRole string) string {
	t.Helper()
	dir := t.TempDir()
	f := AccountsFile{SessionCookie: "eval-session", SearchText: "search-anon-q"}
	for _, role := range MemberRoles {
		spec := testIdentities[role]
		tok, ok := tokens[role]
		if !ok {
			tok = fakeJWT(t, farExpiry.Unix())
		}
		spec.SessionTokenFile = filepath.Join(dir, role+".token")
		if err := os.WriteFile(spec.SessionTokenFile, []byte(tok+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		f.Accounts = append(f.Accounts, spec)
	}
	if apiKeyRole != "" {
		kf := filepath.Join(dir, "api.key")
		if err := os.WriteFile(kf, []byte(testAPIKey), 0o600); err != nil {
			t.Fatal(err)
		}
		f.APIKey = &APIKeySpec{KeyFile: kf, Role: apiKeyRole}
	}
	b, err := json.Marshal(f)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "accounts.json")
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestTokenExpiry(t *testing.T) {
	exp := time.Date(2027, 1, 2, 3, 4, 5, 0, time.UTC)
	got, err := TokenExpiry(fakeJWT(t, exp.Unix()))
	if err != nil || !got.Equal(exp) {
		t.Fatalf("exp %v %v, want %v", got, err, exp)
	}
	got, err = TokenExpiry(fakeJWT(t, nil))
	if err != nil || !got.IsZero() {
		t.Fatalf("no exp: %v %v", got, err)
	}
	for _, bad := range []string{"", "a.b", "a.!!!.c", "a." + base64.RawURLEncoding.EncodeToString([]byte("[1]")) + ".c"} {
		if _, err := TokenExpiry(bad); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
}

func TestLoadAccountsWarnsNearExpiry(t *testing.T) {
	soon := testNow.Add(3*24*time.Hour + time.Hour)
	path := writeAccounts(t, map[string]string{RoleMature: fakeJWT(t, soon.Unix())}, "")
	var warn bytes.Buffer
	a, err := LoadAccounts(path, testNow, &warn)
	if err != nil {
		t.Fatal(err)
	}
	if acc := a.Role(RoleMature); acc == nil || acc.Expired || !acc.Expires.Equal(soon) {
		t.Fatalf("mature account %+v", acc)
	}
	w := warn.String()
	if !strings.Contains(w, "account member-mature: session token expires 2026-11-29T05:00:00Z (in 3.0 days)") {
		t.Fatalf("no expiry warning: %q", w)
	}
	if strings.Count(w, "\n") != 1 {
		t.Fatalf("one warning expected (only the near one): %q", w)
	}
	if got := a.Notes(); !reflect.DeepEqual(got, []AccountNote{{Role: RoleMature, Expires: "2026-11-29T05:00:00Z", State: AccountExpiring}}) {
		t.Fatalf("notes %+v", got)
	}
	// A token 6 days out is not warned about (ExpiryWarning is 5 days).
	warn.Reset()
	path = writeAccounts(t, map[string]string{RoleMature: fakeJWT(t, testNow.Add(6*24*time.Hour).Unix())}, "")
	if _, err := LoadAccounts(path, testNow, &warn); err != nil || warn.Len() != 0 {
		t.Fatalf("6 days out: %v %q", err, warn.String())
	}
}

func TestLoadAccountsExpiredIsNotReplayable(t *testing.T) {
	past := testNow.Add(-time.Hour)
	path := writeAccounts(t, map[string]string{RoleOwner: fakeJWT(t, past.Unix())}, "")
	var warn bytes.Buffer
	a, err := LoadAccounts(path, testNow, &warn)
	if err != nil {
		t.Fatal(err)
	}
	if !a.Role(RoleOwner).Expired {
		t.Fatal("owner not marked expired")
	}
	if got := a.Notes(); !reflect.DeepEqual(got, []AccountNote{{Role: RoleOwner, Expires: "2026-11-26T03:00:00Z", State: AccountExpired}}) {
		t.Fatalf("notes %+v", got)
	}
	if !strings.Contains(warn.String(), "account member-owner: session token EXPIRED at 2026-11-26T03:00:00Z") {
		t.Fatalf("warning %q", warn.String())
	}
	_, why := a.Resolve(Mapping{Role: RoleOwner, Cookie: true}, "")
	if why != "account-expired:member-owner" {
		t.Fatalf("resolve expired: %q", why)
	}
	// The other roles still resolve.
	if c, why := a.Resolve(Mapping{Role: RoleDefault, Cookie: true}, ""); why != "" || c.Identity.UserID != 7101 {
		t.Fatalf("default: %+v %q", c, why)
	}
}

func TestLoadAccountsRefusesWhenNoMemberUsable(t *testing.T) {
	past := fakeJWT(t, testNow.Add(-time.Minute).Unix())
	tokens := map[string]string{}
	for _, r := range MemberRoles {
		tokens[r] = past
	}
	path := writeAccounts(t, tokens, "")
	if _, err := LoadAccounts(path, testNow, &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "no member role") {
		t.Fatalf("err %v", err)
	}
}

func TestLoadAccountsNeverPrintsSecrets(t *testing.T) {
	tok := fakeJWT(t, testNow.Add(-time.Minute).Unix())
	path := writeAccounts(t, map[string]string{RoleDefault: tok}, RoleOwner)
	var warn bytes.Buffer
	if _, err := LoadAccounts(path, testNow, &warn); err != nil {
		t.Fatal(err)
	}
	if warn.Len() == 0 {
		t.Fatal("positive control: an expired token must warn")
	}
	for _, secret := range []string{tok, strings.Split(tok, ".")[1], testAPIKey} {
		if strings.Contains(warn.String(), secret) {
			t.Fatalf("warning holds a secret: %q", warn.String())
		}
	}
}

func TestMapViewer(t *testing.T) {
	cases := []struct {
		name string
		v    evalcorpus.ViewerDescriptor
		cred string
		want Mapping
	}{
		{"moderator", evalcorpus.ViewerDescriptor{Class: "moderator"}, "none", Mapping{NotReplayable: "viewer:moderator"}},
		{"banned", evalcorpus.ViewerDescriptor{Class: "banned"}, "session", Mapping{NotReplayable: "viewer:banned"}},
		{"moderator with a key", evalcorpus.ViewerDescriptor{Class: "moderator"}, "header", Mapping{NotReplayable: "viewer:moderator"}},
		{"anon", evalcorpus.ViewerDescriptor{Class: "anon"}, "none", Mapping{}},
		{"crawler", evalcorpus.ViewerDescriptor{Class: "crawler"}, "none", Mapping{}},
		{"header key", evalcorpus.ViewerDescriptor{Class: "user", Self: true}, "header", Mapping{APIKey: true, Header: true}},
		{"query key", evalcorpus.ViewerDescriptor{Class: "anon"}, "query", Mapping{APIKey: true, Query: true}},
		{"key and session", evalcorpus.ViewerDescriptor{Class: "user"}, "header+query+session", Mapping{APIKey: true, Header: true, Query: true, Cookie: true}},
		{"self beats the rest", evalcorpus.ViewerDescriptor{Class: "user", Self: true, HiddenPrefs: true, ShowNsfw: true}, "session", Mapping{Role: RoleOwner, Cookie: true}},
		{"hidden beats mature", evalcorpus.ViewerDescriptor{Class: "user", HiddenPrefs: true, ShowNsfw: true}, "session", Mapping{Role: RoleFiltered, Cookie: true}},
		{"showNsfw", evalcorpus.ViewerDescriptor{Class: "user", ShowNsfw: true, BrowsingLevel: 3}, "session", Mapping{Role: RoleMature, Cookie: true}},
		{"level R", evalcorpus.ViewerDescriptor{Class: "user", BrowsingLevel: 4}, "session", Mapping{Role: RoleMature, Cookie: true}},
		{"level PG|PG13 is safe", evalcorpus.ViewerDescriptor{Class: "user", BrowsingLevel: 3}, "session", Mapping{Role: RoleDefault, Cookie: true}},
		{"default", evalcorpus.ViewerDescriptor{Class: "user"}, "none", Mapping{Role: RoleDefault, Cookie: true}},
		{"unknown class", evalcorpus.ViewerDescriptor{Class: "robot"}, "none", Mapping{NotReplayable: "viewer:unknown"}},
	}
	for _, c := range cases {
		if got := MapViewer(c.v, c.cred); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

func TestResolveCredentials(t *testing.T) {
	path := writeAccounts(t, nil, RoleFiltered)
	a, err := LoadAccounts(path, testNow, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	anon, why := a.Resolve(Mapping{}, "")
	if why != "" || anon.ViewerUsed != "anon" || anon.Cookie != "" || anon.Bearer != "" || anon.Identity.SearchText != "search-anon-q" {
		t.Fatalf("anon %+v %q", anon, why)
	}
	owner, _ := a.Resolve(Mapping{Role: RoleOwner, Cookie: true}, "")
	if owner.ViewerUsed != RoleOwner || !strings.HasPrefix(owner.Cookie, "eval-session=") || owner.Identity.CollectionID != 8402 {
		t.Fatalf("owner %+v", owner)
	}
	key, _ := a.Resolve(Mapping{APIKey: true, Header: true}, "")
	if key.ViewerUsed != "apikey:member-filtered" || key.Bearer != testAPIKey || key.QueryToken != "" || key.Cookie != "" ||
		key.Identity.UserID != 7401 {
		t.Fatalf("key %+v", key)
	}
	q, _ := a.Resolve(Mapping{APIKey: true, Query: true, Cookie: true}, "")
	if q.QueryToken != testAPIKey || q.Bearer != "" || !strings.HasPrefix(q.Cookie, "eval-session=") {
		t.Fatalf("query key %+v", q)
	}
	// No key configured: a credentialed case is not replayable.
	b, err := LoadAccounts(writeAccounts(t, nil, ""), testNow, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if _, why := b.Resolve(Mapping{APIKey: true, Header: true}, ""); why != "no-api-key" {
		t.Fatalf("no key: %q", why)
	}
}

func TestLoadAccountsRefusesABadFile(t *testing.T) {
	dir := t.TempDir()
	tok := filepath.Join(dir, "tok")
	if err := os.WriteFile(tok, []byte(fakeJWT(t, farExpiry.Unix())), 0o600); err != nil {
		t.Fatal(err)
	}
	notJWT := filepath.Join(dir, "notjwt")
	if err := os.WriteFile(notJWT, []byte("opaque"), 0o600); err != nil {
		t.Fatal(err)
	}
	acc := func(role, file string, id int, name string) string {
		return `{"role":"` + role + `","sessionTokenFile":"` + file + `","userId":` + strconv.Itoa(id) + `,"username":"` + name + `"}`
	}
	ok := acc(RoleDefault, tok, 7101, "evaldefault")
	for name, body := range map[string]string{
		"not json":        `{`,
		"unknown field":   `{"accounts":[],"extra":1}`,
		"bad role":        `{"accounts":[` + acc("Member", tok, 1, "a") + `]}`,
		"duplicate role":  `{"accounts":[` + ok + `,` + ok + `]}`,
		"no user id":      `{"accounts":[` + acc(RoleDefault, tok, 0, "a") + `]}`,
		"no token file":   `{"accounts":[` + acc(RoleDefault, "", 1, "a") + `]}`,
		"absent token":    `{"accounts":[` + acc(RoleDefault, filepath.Join(dir, "absent"), 1, "a") + `]}`,
		"not a JWS":       `{"accounts":[` + acc(RoleDefault, notJWT, 1, "a") + `]}`,
		"key of no role":  `{"accounts":[` + ok + `],"apiKey":{"keyFile":"` + tok + `","role":"member-owner"}}`,
		"key file absent": `{"accounts":[` + ok + `],"apiKey":{"keyFile":"` + filepath.Join(dir, "absent") + `","role":"member-default"}}`,
		"no member role":  `{"accounts":[` + acc("member-other", tok, 1, "a") + `]}`,
	} {
		path := filepath.Join(dir, "accounts.json")
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := LoadAccounts(path, testNow, &bytes.Buffer{}); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
	if _, err := LoadAccounts(filepath.Join(dir, "absent.json"), testNow, &bytes.Buffer{}); err == nil {
		t.Error("absent file: no error")
	}
	// A token with no exp loads, with a warning; an extra role loads and is never mapped to.
	noExp := filepath.Join(dir, "noexp")
	if err := os.WriteFile(noExp, []byte(fakeJWT(t, nil)), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "accounts.json")
	if err := os.WriteFile(path, []byte(`{"accounts":[`+acc(RoleDefault, noExp, 7101, "evaldefault")+`,`+acc("member-extra", tok, 7901, "x")+`]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	var warn bytes.Buffer
	a, err := LoadAccounts(path, testNow, &warn)
	if err != nil || !strings.Contains(warn.String(), "account member-default: session token has no exp") || a.Role("member-extra") == nil {
		t.Fatalf("%v %q", err, warn.String())
	}
	if c, _ := a.Resolve(Mapping{Role: RoleDefault, Cookie: true}, ""); c.Cookie == "" || !strings.HasPrefix(c.Cookie, "__Secure-civ-token=") {
		t.Errorf("default cookie name: %q", strings.SplitN(c.Cookie, "=", 2)[0])
	}
	if _, why := a.Resolve(Mapping{Role: RoleOwner, Cookie: true}, ""); why != "no-account:member-owner" {
		t.Errorf("missing role: %q", why)
	}
}
