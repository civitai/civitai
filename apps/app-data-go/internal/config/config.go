// Package config reads the service's environment. There is no .env loading: every value comes from
// the process environment (see ../../.env.example). A bad value fails the start, never a request.
package config

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Config is the service's settings.
type Config struct {
	// Addr is the HTTP listen address (APP_DATA_ADDR, default :8080).
	Addr string
	// RESTURL is the site the document-store REST read is made against (APP_DATA_REST_URL,
	// required): `/api/v1/blocks/storage/…` is appended. Every request can fall back to it.
	RESTURL string
	// RegistryURL is the registry adapter the per-user streams are opened on, directly, not through
	// a relay (APP_DATA_REGISTRY_URL). Unset, the registry path is OFF: every read is the REST read,
	// no stream is opened and no token is exchanged.
	RegistryURL string
	// Relay is this service's own hub client, which exchanges each user's token for one toward the
	// adapter. Required with RegistryURL, refused without it. Nil when the registry path is off.
	Relay *Relay
	// BlockExchange turns on the exchange of App Block tokens (APP_DATA_BLOCK_EXCHANGE: `true`/`1` on,
	// unset/`false`/`0` off; default off). On, a block token is exchanged at the hub's block exchange
	// with the relay client and read through a stream like a hub token; off, it reads REST only and is
	// never sent to the hub. Needs the registry path.
	BlockExchange bool
	// BlockJWKSURL is the site's block-token JWKS (APP_DATA_BLOCK_JWKS_URL, the site's
	// `/api/v1/block-tokens/jwks`): every block token is verified against it here before it is sent to
	// the hub (exchange.BlockVerifier). Required with BlockExchange, refused without it.
	BlockJWKSURL string

	// MaxStreams caps the streams open at once in this process (APP_DATA_MAX_STREAMS, default 100).
	MaxStreams int
	// MaxStreamsPerToken caps the streams one bearer token holds open (APP_DATA_MAX_STREAMS_PER_TOKEN,
	// default 4): one per collection it reads. At most MaxStreams.
	MaxStreamsPerToken int
	// IdleTTL closes a stream no request has read for this long (APP_DATA_STREAM_IDLE_TTL_MS,
	// default 300000).
	IdleTTL time.Duration
	// MaxAge closes a stream this long after it opened, read or not (APP_DATA_STREAM_MAX_AGE_MS,
	// default 840000, at most 900000: an exchanged token lives at most 15 minutes, and a stream also
	// closes shortly before its own token's expiry). At least IdleTTL.
	MaxAge time.Duration
	// LiveWait bounds how long a request waits for a new stream's snapshot (`Live`) before it reads
	// REST instead (APP_DATA_LIVE_WAIT_MS, default 1500). Less than RequestDeadline.
	LiveWait time.Duration
	// RequestDeadline bounds one request, the REST fallback included (APP_DATA_REQUEST_DEADLINE_MS,
	// default 4000).
	RequestDeadline time.Duration
	// MaxRecords and MaxBytes bound one stream's cache (APP_DATA_MAX_RECORDS_PER_STREAM default 1000,
	// APP_DATA_MAX_BYTES_PER_STREAM default 2097152). A stream that outgrows either is closed and its
	// reads go to REST. Memory held by caches is at most MaxStreams × MaxBytes.
	MaxRecords int
	MaxBytes   int
	// RESTMaxInFlight caps concurrent REST reads (APP_DATA_REST_MAX_INFLIGHT, default 64): when the
	// registry stalls every read falls back, and this keeps that from becoming unbounded load on the
	// site. A read over it answers 503.
	RESTMaxInFlight int

	// Writes turns on the write routes and `info` (APP_DATA_WRITES: `true`/`1` on, unset/`false`/`0`
	// off; default off). Off, every one of them answers 404, as an unregistered route does. On needs
	// WritesSigningKey and BlockJWKSURL (block tokens are verified here before a write is forwarded),
	// but neither the registry path nor the hub: a write is forwarded with the user's own token.
	Writes bool
	// WritesSigningKey is the HMAC key shared with the site, which signs every forward
	// (APP_DATA_WRITES_SIGNING_KEY; at least 32 bytes). Required with Writes, refused without it.
	WritesSigningKey string
	// WritesSiteURL is the site the writes are forwarded to (APP_DATA_WRITES_SITE_URL; default
	// RESTURL, the same site): `/api/internal/blocks/storage/…` is appended to its path.
	WritesSiteURL string
	// WritesTimeout bounds one forward (APP_DATA_WRITES_TIMEOUT_MS, default 10000, from 2000 to
	// MaxWritesTimeout). It must exceed the site's permission-hook client timeout (the hook's
	// timeoutMs, at most 500, plus 450 ms: doc-store-hook.ts hookClientTimeoutMs), plus the rest of
	// the store's chain; a forward past it answers 504 with its outcome unknown.
	WritesTimeout time.Duration

	// ignoredWrites names the APP_DATA_WRITES_* settings set while APP_DATA_WRITES is off
	// (comma-separated, so Config stays comparable); Warnings reports them.
	ignoredWrites string
}

// MaxWritesTimeout caps APP_DATA_WRITES_TIMEOUT_MS so a draining replica can let its last forward
// finish inside the pod's termination: the drain waits for in-flight forwards for up to the timeout
// plus ShutdownMargin, after a preStop pause of PreStopPause, and the whole must fit the termination
// grace period, TerminationGrace (20 s + 2 s + 5 s = 27 s, under 30 s). Raising the cap means raising
// the grace period first. config_test pins the arithmetic.
const MaxWritesTimeout = 20 * time.Second

// The deployment facts MaxWritesTimeout is sized against.
const (
	// ShutdownMargin is how much longer than the forward timeout the drain waits (cmd/app-data-go).
	ShutdownMargin = 2 * time.Second
	// PreStopPause is the deployment's preStop pause before the process is signalled.
	PreStopPause = 5 * time.Second
	// TerminationGrace is the deployment's terminationGracePeriodSeconds.
	TerminationGrace = 30 * time.Second
)

// Warnings are settings that were read but do nothing; the start logs each and goes on.
func (c *Config) Warnings() []string {
	if c.ignoredWrites == "" {
		return nil
	}
	return []string{c.ignoredWrites + " set with APP_DATA_WRITES off: ignored"}
}

// minSigningKeyBytes is the shortest signing key accepted: 256 bits, the HMAC-SHA256 block's half.
const minSigningKeyBytes = 32

// Relay is the hub client the service exchanges users' tokens as (exchange.Config).
type Relay struct {
	// TokenURL is the hub's token endpoint (APP_DATA_HUB_TOKEN_URL).
	TokenURL string
	// ClientID and ClientSecret are this service's confidential client (APP_DATA_CLIENT_ID; the
	// secret from APP_DATA_CLIENT_SECRET_FILE, or APP_DATA_CLIENT_SECRET, never both).
	ClientID, ClientSecret string
	// Resource is the adapter's resource identifier (APP_DATA_EXCHANGE_RESOURCE). The scope asked
	// for is fixed (exchange.Scope), not configuration.
	Resource string
}

// Load reads the environment.
func Load() (*Config, error) { return FromEnv(os.Getenv, os.ReadFile) }

// FromEnv reads settings through getenv, and a secret file through readFile.
func FromEnv(getenv func(string) string, readFile func(string) ([]byte, error)) (*Config, error) {
	c := &Config{
		Addr:        getenv("APP_DATA_ADDR"),
		RESTURL:     getenv("APP_DATA_REST_URL"),
		RegistryURL: getenv("APP_DATA_REGISTRY_URL"),
	}
	if c.Addr == "" {
		c.Addr = ":8080"
	}
	if c.RESTURL == "" {
		return nil, errors.New("APP_DATA_REST_URL is required")
	}
	// Both carry the user's bearer token, so plain http only inside the cluster.
	if !secureURL(c.RESTURL) {
		return nil, errors.New("APP_DATA_REST_URL must be an https URL (http only to a cluster-local *.svc host)")
	}
	if c.RegistryURL != "" && !secureURL(c.RegistryURL) {
		return nil, errors.New("APP_DATA_REGISTRY_URL must be an https URL (http only to a cluster-local *.svc host)")
	}
	relay, err := relayFromEnv(getenv, readFile)
	if err != nil {
		return nil, err
	}
	switch {
	case c.RegistryURL != "" && relay == nil:
		return nil, errors.New("APP_DATA_REGISTRY_URL needs the relay client: APP_DATA_CLIENT_ID and the APP_DATA_CLIENT_* / APP_DATA_HUB_TOKEN_URL / APP_DATA_EXCHANGE_RESOURCE settings")
	case c.RegistryURL == "" && relay != nil:
		return nil, errors.New("the relay client is set without APP_DATA_REGISTRY_URL; set both or neither")
	}
	c.Relay = relay
	switch v := getenv("APP_DATA_BLOCK_EXCHANGE"); v {
	case "", "false", "0":
	case "true", "1":
		if c.RegistryURL == "" {
			return nil, errors.New("APP_DATA_BLOCK_EXCHANGE needs the registry path (APP_DATA_REGISTRY_URL and the relay client)")
		}
		c.BlockExchange = true
	default:
		return nil, errors.New("APP_DATA_BLOCK_EXCHANGE must be true, 1, false or 0")
	}
	if err := writesFromEnv(getenv, c); err != nil {
		return nil, err
	}
	c.BlockJWKSURL = getenv("APP_DATA_BLOCK_JWKS_URL")
	switch {
	case c.BlockExchange && c.BlockJWKSURL == "":
		return nil, errors.New("APP_DATA_BLOCK_EXCHANGE needs APP_DATA_BLOCK_JWKS_URL: block tokens are verified here before they are sent to the hub")
	case c.Writes && c.BlockJWKSURL == "":
		return nil, errors.New("APP_DATA_WRITES needs APP_DATA_BLOCK_JWKS_URL: block tokens are verified here before a write is forwarded")
	case !c.BlockExchange && !c.Writes && c.BlockJWKSURL != "":
		return nil, errors.New("APP_DATA_BLOCK_JWKS_URL is set without APP_DATA_BLOCK_EXCHANGE or APP_DATA_WRITES; set both or neither")
	case c.BlockJWKSURL != "" && !secureURL(c.BlockJWKSURL):
		return nil, errors.New("APP_DATA_BLOCK_JWKS_URL must be an https URL (http only to a cluster-local *.svc host)")
	}

	num := func(name string, def, lo, hi int) int {
		if err != nil {
			return 0
		}
		v, e := intEnv(getenv, name, def, lo, hi)
		err = e
		return v
	}
	ms := func(name string, def, lo, hi int) time.Duration {
		return time.Duration(num(name, def, lo, hi)) * time.Millisecond
	}
	c.MaxStreams = num("APP_DATA_MAX_STREAMS", 100, 1, 10_000)
	c.MaxStreamsPerToken = num("APP_DATA_MAX_STREAMS_PER_TOKEN", 4, 1, 50)
	c.IdleTTL = ms("APP_DATA_STREAM_IDLE_TTL_MS", 300_000, 1_000, 3_600_000)
	c.MaxAge = ms("APP_DATA_STREAM_MAX_AGE_MS", 840_000, 1_000, 900_000)
	c.LiveWait = ms("APP_DATA_LIVE_WAIT_MS", 1_500, 10, 60_000)
	c.RequestDeadline = ms("APP_DATA_REQUEST_DEADLINE_MS", 4_000, 100, 60_000)
	c.MaxRecords = num("APP_DATA_MAX_RECORDS_PER_STREAM", 1_000, 1, 100_000)
	c.MaxBytes = num("APP_DATA_MAX_BYTES_PER_STREAM", 2<<20, 64<<10, 64<<20)
	c.RESTMaxInFlight = num("APP_DATA_REST_MAX_INFLIGHT", 64, 1, 10_000)
	if err != nil {
		return nil, err
	}
	switch {
	case c.MaxStreamsPerToken > c.MaxStreams:
		return nil, errors.New("APP_DATA_MAX_STREAMS_PER_TOKEN must be at most APP_DATA_MAX_STREAMS")
	case c.MaxAge < c.IdleTTL:
		return nil, errors.New("APP_DATA_STREAM_MAX_AGE_MS must be at least APP_DATA_STREAM_IDLE_TTL_MS")
	case c.LiveWait >= c.RequestDeadline:
		return nil, errors.New("APP_DATA_LIVE_WAIT_MS must be less than APP_DATA_REQUEST_DEADLINE_MS, so the REST fallback has time")
	}
	return c, nil
}

// writesFromEnv reads the write settings into c. With APP_DATA_WRITES off they do nothing: any that
// is set is ignored and named in a warning (Warnings), so turning the writes off never needs the
// other settings removed first.
func writesFromEnv(getenv func(string) string, c *Config) error {
	key, site, timeout := getenv("APP_DATA_WRITES_SIGNING_KEY"), getenv("APP_DATA_WRITES_SITE_URL"), getenv("APP_DATA_WRITES_TIMEOUT_MS")
	switch v := getenv("APP_DATA_WRITES"); v {
	case "", "false", "0":
		var set []string
		for name, v := range map[string]string{"APP_DATA_WRITES_SIGNING_KEY": key, "APP_DATA_WRITES_SITE_URL": site, "APP_DATA_WRITES_TIMEOUT_MS": timeout} {
			if v != "" {
				set = append(set, name)
			}
		}
		// Names only, never the key.
		sort.Strings(set)
		c.ignoredWrites = strings.Join(set, ",")
		return nil
	case "true", "1":
	default:
		return errors.New("APP_DATA_WRITES must be true, 1, false or 0")
	}
	switch {
	case key == "":
		return errors.New("APP_DATA_WRITES needs APP_DATA_WRITES_SIGNING_KEY: every forward is signed with it")
	case len(key) < minSigningKeyBytes:
		// The length only; the key never appears.
		return fmt.Errorf("APP_DATA_WRITES_SIGNING_KEY must be at least %d bytes", minSigningKeyBytes)
	}
	if site == "" {
		site = c.RESTURL
	}
	// Every forward carries the user's bearer token.
	if !secureURL(site) {
		return errors.New("APP_DATA_WRITES_SITE_URL must be an https URL (http only to a cluster-local *.svc host)")
	}
	ms, err := intEnv(getenv, "APP_DATA_WRITES_TIMEOUT_MS", 10_000, 2_000, int(MaxWritesTimeout/time.Millisecond))
	if err != nil {
		return err
	}
	c.Writes, c.WritesSigningKey, c.WritesSiteURL = true, key, site
	c.WritesTimeout = time.Duration(ms) * time.Millisecond
	return nil
}

// relayFromEnv reads the relay client: nil when every setting is unset; an error when only some are,
// so a half-configured relay never silently turns the registry path off.
func relayFromEnv(getenv func(string) string, readFile func(string) ([]byte, error)) (*Relay, error) {
	r := &Relay{
		TokenURL: getenv("APP_DATA_HUB_TOKEN_URL"),
		ClientID: getenv("APP_DATA_CLIENT_ID"),
		Resource: getenv("APP_DATA_EXCHANGE_RESOURCE"),
	}
	// The scope used to be a setting; it is fixed now, and a setting that does nothing must not read
	// as if it did.
	if getenv("APP_DATA_EXCHANGE_SCOPE") != "" {
		return nil, errors.New("APP_DATA_EXCHANGE_SCOPE is not a setting: every exchange asks for exactly AppDataRead")
	}
	secret, secretFile := getenv("APP_DATA_CLIENT_SECRET"), getenv("APP_DATA_CLIENT_SECRET_FILE")
	if r.ClientID == "" {
		if r.TokenURL != "" || r.Resource != "" || secret != "" || secretFile != "" {
			return nil, errors.New("APP_DATA_CLIENT_ID is required with any other relay setting")
		}
		return nil, nil
	}
	switch {
	case secret != "" && secretFile != "":
		return nil, errors.New("set APP_DATA_CLIENT_SECRET or APP_DATA_CLIENT_SECRET_FILE, not both")
	case secretFile != "":
		raw, err := readFile(secretFile)
		if err != nil {
			// The path is configuration, not a secret; the file's content never appears.
			return nil, errors.New("APP_DATA_CLIENT_SECRET_FILE could not be read")
		}
		secret = strings.TrimRight(string(raw), "\r\n")
	}
	if secret == "" {
		return nil, errors.New("APP_DATA_CLIENT_ID needs a secret: APP_DATA_CLIENT_SECRET_FILE or APP_DATA_CLIENT_SECRET")
	}
	r.ClientSecret = secret
	if !secureURL(r.TokenURL) {
		return nil, errors.New("APP_DATA_HUB_TOKEN_URL must be an https URL (http only to a cluster-local *.svc host)")
	}
	if u, err := url.Parse(r.Resource); err != nil || u.Scheme != "https" || u.Host == "" {
		return nil, errors.New("APP_DATA_EXCHANGE_RESOURCE must be the adapter's https resource identifier")
	}
	return r, nil
}

func secureURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	return u.Scheme == "https" || (u.Scheme == "http" && clusterLocal(u.Hostname()))
}

// clusterLocal reports whether host is a Kubernetes service name: `*.svc` or `*.svc.cluster.local`.
func clusterLocal(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	return strings.HasSuffix(host, ".svc") || strings.HasSuffix(host, ".svc.cluster.local")
}

func intEnv(getenv func(string) string, name string, def, lo, hi int) (int, error) {
	raw := getenv(name)
	if raw == "" {
		return def, nil
	}
	v, err := strconv.Atoi(raw)
	if err != nil || v < lo || v > hi {
		return 0, fmt.Errorf("%s must be an integer from %d to %d", name, lo, hi)
	}
	return v, nil
}
