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

	// MaxStreams caps the private streams open at once in this process (APP_DATA_MAX_STREAMS, default
	// 100). Every stream, private, level or per-viewer, also counts against MaxSubscriptions.
	MaxStreams int
	// MaxSubscriptions caps the adapter subscriptions this process holds at once, over the private,
	// level and per-viewer streams together (APP_DATA_MAX_SUBSCRIPTIONS, default 100: the replica's
	// share of the adapter's subscription caps, DESIGN.md "Stream budget against the adapter's caps").
	MaxSubscriptions int
	// CacheBudgetBytes caps the bytes the streams' caches may reach together
	// (APP_DATA_CACHE_BUDGET_BYTES, default 234881024, 224 MiB): each open stream reserves its
	// manager's per-stream bound (a private stream MaxBytes, plus MaxOverlayBytes with the writes on;
	// a level stream LevelMaxBytes; a per-viewer stream ViewerMaxBytes), and a stream that would pass
	// the budget is not opened (`capacity`). See MemoryBudget for the arithmetic.
	CacheBudgetBytes int
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
	// MaxRecords and MaxBytes bound one private stream's cache (APP_DATA_MAX_RECORDS_PER_STREAM default
	// 1000, APP_DATA_MAX_BYTES_PER_STREAM default 2097152). A stream that outgrows either is closed and
	// its reads go to REST. What all the caches hold together is bounded by CacheBudgetBytes.
	MaxRecords int
	MaxBytes   int
	// MaxOverlayBytes bounds one private stream's read-your-writes overlays, apart from its records
	// (APP_DATA_MAX_OVERLAY_BYTES_PER_STREAM, default 131072; at least 98304, so one record of the
	// store's largest body, 64 KiB, always fits). Read with the writes on only.
	MaxOverlayBytes int
	// LevelMaxStreams, LevelMaxRecords and LevelMaxBytes bound the shared collections' level streams
	// (APP_DATA_LEVEL_MAX_STREAMS default 10, APP_DATA_LEVEL_MAX_RECORDS default 3000,
	// APP_DATA_LEVEL_MAX_BYTES default 8388608), read only with SharedReads. A level stream holds up
	// to the adapter's own bound (REGISTRY_ADAPTER_LEVEL_STREAM_MAX_RECORDS, default 2500, always above
	// 2000), so LevelMaxRecords must be at least that: a level stream past it is closed here and its
	// reads answer 503 too_large.
	LevelMaxStreams, LevelMaxRecords, LevelMaxBytes int
	// ViewerMaxStreams, ViewerMaxRecords and ViewerMaxBytes bound the per-viewer streams
	// (APP_DATA_VIEWER_MAX_STREAMS default 40, APP_DATA_VIEWER_MAX_RECORDS default 20000,
	// APP_DATA_VIEWER_MAX_BYTES default 4194304), read only with SharedReads. The adapter ends a
	// per-viewer stream past its own bound (REGISTRY_ADAPTER_VIEWER_STREAM_MAX_RECORDS, default
	// 20000), so ViewerMaxRecords at that bound closes nothing the adapter would serve. A per-viewer
	// stream past ViewerMaxBytes is closed and its reads answer 503 too_large.
	ViewerMaxStreams, ViewerMaxRecords, ViewerMaxBytes int
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
	// AdapterPoll is how long a stream may lag a write (APP_DATA_WRITES_ADAPTER_POLL_SECONDS, default
	// 60, from 1 to 600), kept at or above the adapter's REGISTRY_ADAPTER_POLL_SECONDS: an overlay lives
	// this plus 30 s, and a floor reopens a stream at most once per it. Zero with Writes off.
	AdapterPoll time.Duration

	// SharedReads is on with Writes and the registry path together: shared collections and signed-out
	// viewers are read from the adapter's level and per-viewer streams (package shared), the level
	// streams under this service's own service token (Service, client credentials).
	SharedReads bool
	// Service is this service's own service client, the level streams' token is minted as
	// (APP_DATA_SERVICE_CLIENT_ID; the secret from APP_DATA_SERVICE_CLIENT_SECRET_FILE, or
	// APP_DATA_SERVICE_CLIENT_SECRET, never both), at the relay's token endpoint for the relay's
	// resource. It is a client of its own: the hub mints a service token only for a client whose
	// grants are exactly the service grant, and refuses a client that is both a relay and a service,
	// so the relay client can never mint it. Nil when unset: shared reads are then refused
	// `service_client_unconfigured` (with a start warning while SharedReads is on), never read under
	// the relay client. Needs the registry path.
	Service *ServiceClient

	// ForwardRegion copies the edge's region headers (cf-ipcountry, cf-region-code, x-isuk) from a
	// viewer's request onto the private and per-viewer subscriptions opened for that viewer, so the
	// adapter judges the viewer's region rather than this relay's, which has none and is held to SFW
	// (APP_DATA_FORWARD_REGION: `true`/`1` on, unset/`false`/`0` off; default off). Turn it on only
	// while this service is reachable through the edge alone, which sets those headers and strips any
	// a client sent (WRITES-DESIGN.md, "Region", precondition). Level streams never carry a region:
	// they are read as a service, which no region holds. Needs the registry path.
	ForwardRegion bool

	// Cache is the shared cache in front of the exchanges, the overlays and the private streams'
	// snapshots (APP_DATA_CACHE_URL; CACHE-DESIGN.md). Nil when unset: nothing is cached anywhere but
	// in this process, as before. Needs the registry path.
	Cache *Cache

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

// Warnings are settings that were read but do nothing, or a feature on without what it needs; the
// start logs each and goes on.
func (c *Config) Warnings() []string {
	var w []string
	if c.ignoredWrites != "" {
		w = append(w, c.ignoredWrites+" set with APP_DATA_WRITES off: ignored")
	}
	switch {
	case c.SharedReads && c.Service == nil:
		w = append(w, NoServiceClientWarning)
	case !c.SharedReads && c.Service != nil:
		w = append(w, "APP_DATA_SERVICE_CLIENT_ID set without shared reads (APP_DATA_WRITES and APP_DATA_REGISTRY_URL): ignored")
	}
	return w
}

// NoServiceClientWarning is the start warning for shared reads with no service client.
const NoServiceClientWarning = "shared reads are on without a service client (APP_DATA_SERVICE_CLIENT_ID): " +
	"every shared and signed-out read is refused service_client_unconfigured"

// Cache is the shared cache's settings.
type Cache struct {
	// URL is the valkey instance (APP_DATA_CACHE_URL): redis:// or valkey:// only to a cluster-local
	// *.svc host, else rediss:// or valkeys://; a host, an optional port and an optional /db, no
	// credentials.
	URL string
	// Key seals every value and names every key (APP_DATA_CACHE_KEY_FILE, preferred, or
	// APP_DATA_CACHE_KEY, never both; at least 32 bytes). Changing it turns every cached value into a
	// miss.
	Key []byte
	// Password, when set, authenticates every connection (APP_DATA_CACHE_PASSWORD_FILE or
	// APP_DATA_CACHE_PASSWORD, never both; optional).
	Password string
	// Timeout bounds each cache operation (APP_DATA_CACHE_OP_TIMEOUT_MS, default 100, from 5 to 2000).
	// A slower one is a miss or a no-op.
	Timeout time.Duration
}

// ServiceClient is the hub client the level streams' service token is minted as (token.Config).
type ServiceClient struct {
	ClientID, ClientSecret string
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
	service, err := serviceFromEnv(getenv, readFile)
	if err != nil {
		return nil, err
	}
	switch {
	case service != nil && relay == nil:
		return nil, errors.New("APP_DATA_SERVICE_CLIENT_ID needs the registry path (APP_DATA_REGISTRY_URL and the relay client): the service token is minted at its token endpoint")
	case service != nil && service.ClientID == relay.ClientID:
		// The hub refuses a client that is both a relay and a service; this is the case the separate
		// client exists to end.
		return nil, errors.New("APP_DATA_SERVICE_CLIENT_ID must be a service client of its own, not the relay client APP_DATA_CLIENT_ID")
	}
	c.Service = service
	switch v := getenv("APP_DATA_FORWARD_REGION"); v {
	case "", "false", "0":
	case "true", "1":
		if c.RegistryURL == "" {
			return nil, errors.New("APP_DATA_FORWARD_REGION needs the registry path (APP_DATA_REGISTRY_URL and the relay client)")
		}
		c.ForwardRegion = true
	default:
		return nil, errors.New("APP_DATA_FORWARD_REGION must be true, 1, false or 0")
	}
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
	if c.Cache, err = cacheFromEnv(getenv, readFile, c.RegistryURL != ""); err != nil {
		return nil, err
	}
	c.SharedReads = c.Writes && c.RegistryURL != ""
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
	c.MaxSubscriptions = num("APP_DATA_MAX_SUBSCRIPTIONS", 100, 1, 10_000)
	c.CacheBudgetBytes = num("APP_DATA_CACHE_BUDGET_BYTES", DefaultCacheBudgetBytes, 8<<20, 16<<30)
	c.MaxOverlayBytes = num("APP_DATA_MAX_OVERLAY_BYTES_PER_STREAM", 128<<10, 96<<10, 64<<20)
	c.MaxStreamsPerToken = num("APP_DATA_MAX_STREAMS_PER_TOKEN", 4, 1, 50)
	c.IdleTTL = ms("APP_DATA_STREAM_IDLE_TTL_MS", 300_000, 1_000, 3_600_000)
	c.MaxAge = ms("APP_DATA_STREAM_MAX_AGE_MS", 840_000, 1_000, 900_000)
	c.LiveWait = ms("APP_DATA_LIVE_WAIT_MS", 1_500, 10, 60_000)
	c.RequestDeadline = ms("APP_DATA_REQUEST_DEADLINE_MS", 4_000, 100, 60_000)
	c.MaxRecords = num("APP_DATA_MAX_RECORDS_PER_STREAM", 1_000, 1, 100_000)
	c.MaxBytes = num("APP_DATA_MAX_BYTES_PER_STREAM", 2<<20, 64<<10, 64<<20)
	c.RESTMaxInFlight = num("APP_DATA_REST_MAX_INFLIGHT", 64, 1, 10_000)
	c.LevelMaxStreams = num("APP_DATA_LEVEL_MAX_STREAMS", 10, 1, 1_000)
	c.LevelMaxRecords = num("APP_DATA_LEVEL_MAX_RECORDS", 3_000, 2_001, 100_000)
	c.LevelMaxBytes = num("APP_DATA_LEVEL_MAX_BYTES", 8<<20, 1<<20, 256<<20)
	c.ViewerMaxStreams = num("APP_DATA_VIEWER_MAX_STREAMS", 40, 1, 10_000)
	c.ViewerMaxRecords = num("APP_DATA_VIEWER_MAX_RECORDS", 20_000, 1, 1_000_000)
	c.ViewerMaxBytes = num("APP_DATA_VIEWER_MAX_BYTES", 4<<20, 64<<10, 256<<20)
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
	case c.CacheBudgetBytes < c.PrivateReserve():
		return nil, errors.New("APP_DATA_CACHE_BUDGET_BYTES must hold at least one private stream (APP_DATA_MAX_BYTES_PER_STREAM, plus APP_DATA_MAX_OVERLAY_BYTES_PER_STREAM with the writes on)")
	case c.SharedReads && (c.CacheBudgetBytes < c.LevelMaxBytes || c.CacheBudgetBytes < c.ViewerMaxBytes):
		return nil, errors.New("APP_DATA_CACHE_BUDGET_BYTES must hold at least one level stream and one per-viewer stream (APP_DATA_LEVEL_MAX_BYTES, APP_DATA_VIEWER_MAX_BYTES)")
	}
	return c, nil
}

// PrivateReserve is what one private stream reserves from the cache budget: its records' bound, plus
// its overlays' with the writes on.
func (c *Config) PrivateReserve() int {
	if !c.Writes {
		return c.MaxBytes
	}
	return c.MaxBytes + c.MaxOverlayBytes
}

// MaxSharedOverlayBytes bounds the acknowledged shared writes held in all (cmd/app-data-go), apart
// from the cache budget.
const MaxSharedOverlayBytes = 16 << 20

// The memory the defaults are sized against: the deployment's GOMEMLIMIT of 400 MiB, under a 512 Mi
// container limit.
const (
	DeploymentMemLimit = 400 << 20

	// DefaultCacheBudgetBytes is 224 MiB. With the shared overlays' 16 MiB it is 240 MiB of cache,
	// 60% of GOMEMLIMIT, the other 160 MiB left to the runtime, each cached record's own overhead
	// past its counted bytes, and in-flight requests. What it holds at the defaults, for example:
	// 100 private streams with the writes off (100 × 2 MiB = 200 MiB) or on (100 × 2.125 MiB =
	// 212.5 MiB), as before any budget; with shared reads, 10 level streams (10 × 8 MiB = 80 MiB) and
	// 20 per-viewer (20 × 4 MiB = 80 MiB) leave 64 MiB, 30 private streams (63.75 MiB). Whatever the
	// mix, at most MaxSubscriptions (100) streams and this many bytes. config_test pins the sum.
	DefaultCacheBudgetBytes = 224 << 20
)

// MemoryBudget is the most the streams' caches and the shared overlays may hold together.
func (c *Config) MemoryBudget() int {
	if !c.SharedReads {
		return c.CacheBudgetBytes
	}
	return c.CacheBudgetBytes + MaxSharedOverlayBytes
}

// writesFromEnv reads the write settings into c. With APP_DATA_WRITES off they do nothing: any that
// is set is ignored and named in a warning (Warnings), so turning the writes off never needs the
// other settings removed first.
func writesFromEnv(getenv func(string) string, c *Config) error {
	key, site, timeout := getenv("APP_DATA_WRITES_SIGNING_KEY"), getenv("APP_DATA_WRITES_SITE_URL"), getenv("APP_DATA_WRITES_TIMEOUT_MS")
	poll := getenv("APP_DATA_WRITES_ADAPTER_POLL_SECONDS")
	switch v := getenv("APP_DATA_WRITES"); v {
	case "", "false", "0":
		var set []string
		for name, v := range map[string]string{"APP_DATA_WRITES_SIGNING_KEY": key, "APP_DATA_WRITES_SITE_URL": site,
			"APP_DATA_WRITES_TIMEOUT_MS": timeout, "APP_DATA_WRITES_ADAPTER_POLL_SECONDS": poll} {
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
	secs, err := intEnv(getenv, "APP_DATA_WRITES_ADAPTER_POLL_SECONDS", 60, 1, 600)
	if err != nil {
		return err
	}
	c.AdapterPoll = time.Duration(secs) * time.Second
	c.Writes, c.WritesSigningKey, c.WritesSiteURL = true, key, site
	c.WritesTimeout = time.Duration(ms) * time.Millisecond
	return nil
}

// minCacheKeyBytes is the shortest APP_DATA_CACHE_KEY accepted (cache.MinSecretBytes).
const minCacheKeyBytes = 32

// cacheFromEnv reads the shared cache: nil when APP_DATA_CACHE_URL is unset (and every other cache
// setting with it); an error for any setting that is wrong, so a bad value fails the start rather
// than silently turning the cache off.
func cacheFromEnv(getenv func(string) string, readFile func(string) ([]byte, error), registry bool) (*Cache, error) {
	raw := getenv("APP_DATA_CACHE_URL")
	key, keyFile := getenv("APP_DATA_CACHE_KEY"), getenv("APP_DATA_CACHE_KEY_FILE")
	pass, passFile := getenv("APP_DATA_CACHE_PASSWORD"), getenv("APP_DATA_CACHE_PASSWORD_FILE")
	timeout := getenv("APP_DATA_CACHE_OP_TIMEOUT_MS")
	if raw == "" {
		if key != "" || keyFile != "" || pass != "" || passFile != "" || timeout != "" {
			return nil, errors.New("the APP_DATA_CACHE_* settings need APP_DATA_CACHE_URL; set it, or none of them")
		}
		return nil, nil
	}
	if !registry {
		return nil, errors.New("APP_DATA_CACHE_URL needs the registry path (APP_DATA_REGISTRY_URL and the relay client): everything it caches is the registry path's")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("APP_DATA_CACHE_URL must be a URL naming a host only (no credentials, query or fragment)")
	}
	switch u.Scheme {
	case "rediss", "valkeys":
	case "redis", "valkey":
		// Values are sealed, but the connection still carries the password and the access pattern.
		if !clusterLocal(u.Hostname()) {
			return nil, errors.New("APP_DATA_CACHE_URL must be rediss:// or valkeys:// (redis:// or valkey:// only to a cluster-local *.svc host)")
		}
	default:
		return nil, errors.New("APP_DATA_CACHE_URL must be a redis://, rediss://, valkey:// or valkeys:// URL")
	}
	if p := strings.Trim(u.Path, "/"); p != "" {
		if db, err := strconv.Atoi(p); err != nil || db < 0 || db > 15 {
			return nil, errors.New("APP_DATA_CACHE_URL's path must be a database number from 0 to 15")
		}
	}
	c := &Cache{URL: raw}
	k, err := secretFromEnv("APP_DATA_CACHE_KEY", key, keyFile, readFile)
	switch {
	case err != nil:
		return nil, err
	case k == "":
		return nil, errors.New("APP_DATA_CACHE_URL needs APP_DATA_CACHE_KEY_FILE or APP_DATA_CACHE_KEY: every cached value is sealed with it")
	case len(k) < minCacheKeyBytes:
		// The length only; the key never appears.
		return nil, fmt.Errorf("APP_DATA_CACHE_KEY must be at least %d bytes", minCacheKeyBytes)
	}
	c.Key = []byte(k)
	if c.Password, err = secretFromEnv("APP_DATA_CACHE_PASSWORD", pass, passFile, readFile); err != nil {
		return nil, err
	}
	ms, err := intEnv(getenv, "APP_DATA_CACHE_OP_TIMEOUT_MS", 100, 5, 2_000)
	if err != nil {
		return nil, err
	}
	c.Timeout = time.Duration(ms) * time.Millisecond
	return c, nil
}

// secretFromEnv is a secret set as name (value) or name_FILE (file, read through readFile, its trailing
// line break dropped), never both; "" when neither is set. No error carries the secret.
func secretFromEnv(name, value, file string, readFile func(string) ([]byte, error)) (string, error) {
	switch {
	case value != "" && file != "":
		return "", fmt.Errorf("set %s or %s_FILE, not both", name, name)
	case file != "":
		raw, err := readFile(file)
		if err != nil {
			// The path is configuration, not a secret; the file's content never appears.
			return "", fmt.Errorf("%s_FILE could not be read", name)
		}
		return strings.TrimRight(string(raw), "\r\n"), nil
	}
	return value, nil
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

// serviceFromEnv reads the service client: nil when every setting is unset; an error when only some
// are.
func serviceFromEnv(getenv func(string) string, readFile func(string) ([]byte, error)) (*ServiceClient, error) {
	id := getenv("APP_DATA_SERVICE_CLIENT_ID")
	secret, secretFile := getenv("APP_DATA_SERVICE_CLIENT_SECRET"), getenv("APP_DATA_SERVICE_CLIENT_SECRET_FILE")
	if id == "" {
		if secret != "" || secretFile != "" {
			return nil, errors.New("APP_DATA_SERVICE_CLIENT_ID is required with APP_DATA_SERVICE_CLIENT_SECRET or APP_DATA_SERVICE_CLIENT_SECRET_FILE")
		}
		return nil, nil
	}
	switch {
	case secret != "" && secretFile != "":
		return nil, errors.New("set APP_DATA_SERVICE_CLIENT_SECRET or APP_DATA_SERVICE_CLIENT_SECRET_FILE, not both")
	case secretFile != "":
		raw, err := readFile(secretFile)
		if err != nil {
			// The path is configuration, not a secret; the file's content never appears.
			return nil, errors.New("APP_DATA_SERVICE_CLIENT_SECRET_FILE could not be read")
		}
		secret = strings.TrimRight(string(raw), "\r\n")
	}
	if secret == "" {
		return nil, errors.New("APP_DATA_SERVICE_CLIENT_ID needs a secret: APP_DATA_SERVICE_CLIENT_SECRET_FILE or APP_DATA_SERVICE_CLIENT_SECRET")
	}
	return &ServiceClient{ClientID: id, ClientSecret: secret}, nil
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
