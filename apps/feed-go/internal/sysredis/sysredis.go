// Package sysredis builds the system-Redis client the way the Node app's @civitai/redis package
// does (packages/civitai-redis/src/client.ts, getBaseClient('system')), from the same env vars:
//
//   - REDIS_SYS_SENTINELS non-empty: Sentinel mode. The client asks the Sentinels in that
//     comma-separated host[:port] list (port defaults to 26379) for the master of group
//     REDIS_SYS_SENTINEL_NAME and follows it across failovers (go-redis NewFailoverClient). The
//     group name is required, as the Node env schema requires it: a missing name would ask for the
//     wrong group and never resolve a master. The master password comes from REDIS_SYS_URL (its
//     host is not used); REDIS_SYS_SENTINEL_PASSWORD, when set, authenticates to the Sentinels.
//   - otherwise: a single connection to REDIS_SYS_URL.
//
// Both modes use logical database 0 and ignore any path in REDIS_SYS_URL, as Node does (it
// connects to `protocol//host` only). In Sentinel mode no TLS is used and only the password from
// REDIS_SYS_URL is sent (no username), as on the Node Sentinel branch; in single-connection mode a
// rediss:// URL enables TLS and a username is sent, as there.
package sysredis

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"
)

// DefaultSentinelPort is the port used for a REDIS_SYS_SENTINELS entry that names none (Node's
// default for the same case).
const DefaultSentinelPort = "26379"

// Settings is the system-Redis slice of the environment.
type Settings struct {
	URL              string // REDIS_SYS_URL
	Sentinels        string // REDIS_SYS_SENTINELS
	SentinelName     string // REDIS_SYS_SENTINEL_NAME
	SentinelPassword string // REDIS_SYS_SENTINEL_PASSWORD
}

// Options resolves Settings to exactly one of: Sentinel (failover) options, or single-connection
// options. The other is nil.
func Options(s Settings) (*redis.FailoverOptions, *redis.Options, error) {
	if s.URL == "" {
		return nil, nil, errors.New("REDIS_SYS_URL is required")
	}
	if s.Sentinels == "" {
		opts, err := redis.ParseURL(s.URL)
		if err != nil {
			return nil, nil, fmt.Errorf("REDIS_SYS_URL: %w", err)
		}
		opts.DB = 0
		return nil, opts, nil
	}
	if s.SentinelName == "" {
		return nil, nil, errors.New("REDIS_SYS_SENTINEL_NAME is required when REDIS_SYS_SENTINELS is set")
	}
	addrs, err := sentinelAddrs(s.Sentinels)
	if err != nil {
		return nil, nil, err
	}
	u, err := url.Parse(s.URL)
	if err != nil {
		return nil, nil, fmt.Errorf("REDIS_SYS_URL: %w", err)
	}
	password, _ := u.User.Password()
	return &redis.FailoverOptions{
		MasterName:       s.SentinelName,
		SentinelAddrs:    addrs,
		SentinelPassword: s.SentinelPassword,
		Password:         password,
		DB:               0,
	}, nil, nil
}

// New builds the system-Redis client for Settings.
func New(s Settings) (redis.UniversalClient, error) {
	failover, plain, err := Options(s)
	if err != nil {
		return nil, err
	}
	if failover != nil {
		return redis.NewFailoverClient(failover), nil
	}
	return redis.NewClient(plain), nil
}

func sentinelAddrs(raw string) ([]string, error) {
	var out []string
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		host, port := part, DefaultSentinelPort
		if strings.Contains(part, ":") {
			h, p, err := net.SplitHostPort(part)
			if err != nil {
				return nil, fmt.Errorf("REDIS_SYS_SENTINELS entry %q: %w", part, err)
			}
			host, port = h, p
		}
		if host == "" {
			return nil, fmt.Errorf("REDIS_SYS_SENTINELS entry %q has no host", part)
		}
		if n, err := strconv.Atoi(port); err != nil || n <= 0 || n > 65535 {
			return nil, fmt.Errorf("REDIS_SYS_SENTINELS entry %q has an invalid port", part)
		}
		out = append(out, net.JoinHostPort(host, port))
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("REDIS_SYS_SENTINELS is set but names no sentinel")
	}
	return out, nil
}
