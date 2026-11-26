package evalharness

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/civitai/civitai/apps/feed-go/internal/auth"
)

// The member roles the viewer mapping (MapViewer) asks for. An accounts file may name more (they are
// loaded, never mapped to).
const (
	RoleDefault  = "member-default"  // a signed-in member, default settings
	RoleMature   = "member-mature"   // showNsfw on, a browsing level past the safe levels
	RoleFiltered = "member-filtered" // non-empty hidden preferences
	RoleOwner    = "member-owner"    // owns content and a collection: the cases that named the viewer
)

// MemberRoles is every role the mapping uses.
var MemberRoles = []string{RoleDefault, RoleMature, RoleFiltered, RoleOwner}

// ExpiryWarning is how close to its expiry a session token is warned about.
const ExpiryWarning = 5 * 24 * time.Hour

// AccountsFile is FEED_EVAL_ACCOUNTS_FILE's JSON. Secrets are never in it: each is a path to a file
// mounted from a secret, read at startup and never logged.
type AccountsFile struct {
	// SessionCookie is the session cookie's name ("": auth.SessionCookieName(true)).
	SessionCookie string `json:"sessionCookie,omitempty"`
	// SearchText is the search text a `$search` placeholder becomes for a case replayed signed out,
	// and for an account that names none.
	SearchText string        `json:"searchText,omitempty"`
	Accounts   []AccountSpec `json:"accounts"`
	// APIKey is the read-only API key (nil: none; a credentialed case is then not replayable).
	APIKey *APIKeySpec `json:"apiKey,omitempty"`
}

// AccountSpec is one eval account.
type AccountSpec struct {
	Role string `json:"role"`
	// SessionTokenFile is the path of a file holding the account's session token (a JWS).
	SessionTokenFile string `json:"sessionTokenFile"`
	// UserID, Username and CollectionID are what `$self` and `$self-collection` become.
	UserID       int    `json:"userId"`
	Username     string `json:"username"`
	CollectionID int    `json:"collectionId,omitempty"`
	SearchText   string `json:"searchText,omitempty"`
}

// APIKeySpec is the read-only API key: the file holding it, and the role of the account it belongs to.
type APIKeySpec struct {
	KeyFile string `json:"keyFile"`
	Role    string `json:"role"`
}

// Account is one loaded account. The token is unexported and never printed.
type Account struct {
	Role         string
	UserID       int
	Username     string
	CollectionID int
	SearchText   string
	// Expires is the token's `exp` (zero: it has none); Expired whether it had passed at load.
	Expires time.Time
	Expired bool
	token   string
}

// Account note states (AccountNote.State).
const (
	AccountExpiring = "expiring" // within ExpiryWarning of its exp
	AccountExpired  = "expired"
	AccountNoExp    = "no-exp"
)

// AccountNote is one account whose session token needs attention: its role, its exp (RFC 3339, ""
// when none) and why. Recorded in runs.settings and shown on the index page; never a token.
type AccountNote struct {
	Role    string `json:"role"`
	Expires string `json:"expires"`
	State   string `json:"state"`
}

// Accounts is the loaded accounts file.
type Accounts struct {
	notes      []AccountNote
	cookie     string
	searchText string
	byRole     map[string]*Account
	apiKey     string
	apiKeyRole string
}

var roleRE = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)

// LoadAccounts reads the accounts file at path and every secret file it names, checks each session
// token's `exp` (read, not verified: the token is the app's to verify) against now, and warns on warn
// about each token within ExpiryWarning of expiring or already expired (role and date only). An
// expired account stays loaded with Expired set: its cases are not_replayable. It refuses a file in
// which no member role (MemberRoles) has a usable account: a run would then replay signed-out cases
// only, which reads as coverage it is not.
func LoadAccounts(path string, now time.Time, warn io.Writer) (*Accounts, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // G304: the operator's own config path
	if err != nil {
		return nil, fmt.Errorf("accounts file: %w", err)
	}
	var f AccountsFile
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return nil, fmt.Errorf("accounts file: %w", err)
	}
	a := &Accounts{cookie: f.SessionCookie, searchText: f.SearchText, byRole: map[string]*Account{}}
	if a.cookie == "" {
		a.cookie = auth.SessionCookieName(true)
	}
	for _, spec := range f.Accounts {
		if !roleRE.MatchString(spec.Role) {
			return nil, fmt.Errorf("accounts file: role %q: want [a-z][a-z0-9-]*", spec.Role)
		}
		if _, dup := a.byRole[spec.Role]; dup {
			return nil, fmt.Errorf("accounts file: role %s twice", spec.Role)
		}
		if spec.UserID <= 0 || spec.Username == "" {
			return nil, fmt.Errorf("accounts file: role %s: userId and username are required", spec.Role)
		}
		tok, err := readSecret(spec.SessionTokenFile)
		if err != nil {
			return nil, fmt.Errorf("accounts file: role %s: session token: %w", spec.Role, err)
		}
		exp, err := TokenExpiry(tok)
		if err != nil {
			return nil, fmt.Errorf("accounts file: role %s: session token: %w", spec.Role, err)
		}
		acc := &Account{Role: spec.Role, UserID: spec.UserID, Username: spec.Username, CollectionID: spec.CollectionID,
			SearchText: spec.SearchText, Expires: exp, token: tok}
		if acc.SearchText == "" {
			acc.SearchText = f.SearchText
		}
		switch {
		case exp.IsZero():
			a.notes = append(a.notes, AccountNote{Role: spec.Role, State: AccountNoExp})
			_, _ = fmt.Fprintf(warn, "feed-eval: account %s: session token has no exp\n", spec.Role)
		case !now.Before(exp):
			acc.Expired = true
			a.notes = append(a.notes, AccountNote{Role: spec.Role, Expires: exp.UTC().Format(time.RFC3339), State: AccountExpired})
			_, _ = fmt.Fprintf(warn, "feed-eval: account %s: session token EXPIRED at %s; its cases are not replayable\n",
				spec.Role, exp.UTC().Format(time.RFC3339))
		case exp.Sub(now) <= ExpiryWarning:
			a.notes = append(a.notes, AccountNote{Role: spec.Role, Expires: exp.UTC().Format(time.RFC3339), State: AccountExpiring})
			_, _ = fmt.Fprintf(warn, "feed-eval: account %s: session token expires %s (in %.1f days)\n",
				spec.Role, exp.UTC().Format(time.RFC3339), exp.Sub(now).Hours()/24)
		}
		a.byRole[spec.Role] = acc
	}
	if f.APIKey != nil {
		if _, ok := a.byRole[f.APIKey.Role]; !ok {
			return nil, fmt.Errorf("accounts file: apiKey role %q is not an account", f.APIKey.Role)
		}
		key, err := readSecret(f.APIKey.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("accounts file: apiKey: %w", err)
		}
		a.apiKey, a.apiKeyRole = key, f.APIKey.Role
	}
	usable := 0
	for _, r := range MemberRoles {
		if acc, ok := a.byRole[r]; ok && !acc.Expired {
			usable++
		}
	}
	if usable == 0 {
		return nil, errors.New("accounts file: no member role has a usable account (only signed-out cases would replay)")
	}
	return a, nil
}

// readSecret is a secret file's content, surrounding space trimmed; an empty one is an error.
func readSecret(path string) (string, error) {
	if path == "" {
		return "", errors.New("no file named")
	}
	b, err := os.ReadFile(path) //nolint:gosec // G304: a mounted secret's path from the operator's config
	if err != nil {
		// Not wrapped with the content; the path is the operator's.
		return "", fmt.Errorf("read %s: %w", path, err)
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return "", fmt.Errorf("%s is empty", path)
	}
	return s, nil
}

// TokenExpiry is a JWS's `exp` claim, read without verifying the signature (zero: no exp). An error
// when the token is not three base64url parts with a JSON object payload.
func TokenExpiry(token string) (time.Time, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}, errors.New("not a JWS (want three dot-separated parts)")
	}
	payload, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return time.Time{}, errors.New("payload is not base64url")
	}
	var claims struct {
		Exp *float64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return time.Time{}, errors.New("payload is not a JSON object")
	}
	if claims.Exp == nil {
		return time.Time{}, nil
	}
	sec := int64(*claims.Exp)
	return time.Unix(sec, int64((*claims.Exp-float64(sec))*1e9)).UTC(), nil
}

// Notes is every account whose token is expiring, expired or has no exp, in file order (a copy).
func (a *Accounts) Notes() []AccountNote {
	if a == nil {
		return []AccountNote{}
	}
	return append([]AccountNote{}, a.notes...)
}

// Role is the account of role (nil when there is none).
func (a *Accounts) Role(role string) *Account { return a.byRole[role] }
