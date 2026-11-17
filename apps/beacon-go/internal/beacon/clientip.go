package beacon

import (
	"regexp"
	"strings"

	"github.com/civitai/civitai/apps/beacon-go/internal/fallback"
	"github.com/civitai/civitai/apps/beacon-go/internal/jsvalue"
)

// Node's net.isIP (lib/internal/net.js IPv4Reg / IPv6Reg), which RE2 can express as written.
var (
	nodeV4Seg = `(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])`
	nodeV4Str = `(?:` + nodeV4Seg + `\.){3}` + nodeV4Seg
	nodeV6Seg = `(?:[0-9a-fA-F]{1,4})`
	nodeIPv4  = regexp.MustCompile(`^` + nodeV4Str + `$`)
	nodeIPv6  = regexp.MustCompile(`^(?:` +
		`(?:` + nodeV6Seg + `:){7}(?:` + nodeV6Seg + `|:)|` +
		`(?:` + nodeV6Seg + `:){6}(?:` + nodeV4Str + `|:` + nodeV6Seg + `|:)|` +
		`(?:` + nodeV6Seg + `:){5}(?::` + nodeV4Str + `|(?::` + nodeV6Seg + `){1,2}|:)|` +
		`(?:` + nodeV6Seg + `:){4}(?:(?::` + nodeV6Seg + `){0,1}:` + nodeV4Str + `|(?::` + nodeV6Seg + `){1,3}|:)|` +
		`(?:` + nodeV6Seg + `:){3}(?:(?::` + nodeV6Seg + `){0,2}:` + nodeV4Str + `|(?::` + nodeV6Seg + `){1,4}|:)|` +
		`(?:` + nodeV6Seg + `:){2}(?:(?::` + nodeV6Seg + `){0,3}:` + nodeV4Str + `|(?::` + nodeV6Seg + `){1,5}|:)|` +
		`(?:` + nodeV6Seg + `:){1}(?:(?::` + nodeV6Seg + `){0,4}:` + nodeV4Str + `|(?::` + nodeV6Seg + `){1,6}|:)|` +
		`(?::(?:(?::` + nodeV6Seg + `){0,5}:` + nodeV4Str + `|(?::` + nodeV6Seg + `){1,7}|:))` +
		`)$`)
)

// (Node's IPv6Reg also accepts a `%zone` suffix; isIpAddress refuses any `%` before the regex runs,
// so the suffix is left out here.)

// isIPAddress is src/server/utils/client-ip.ts isIpAddress: at most 45 UTF-16 units, no `%`, and
// net.isIP() non-zero.
func isIPAddress(v string) bool {
	if jsvalue.UTF16Len(v) > 45 || strings.Contains(v, "%") {
		return false
	}
	return nodeIPv4.MatchString(v) || nodeIPv6.MatchString(v)
}

// request-ip 3.3.0 (lib/is.js) ipv4 regex. Its ipv6 regex needs lookaheads and backreferences (not
// RE2), but it cannot match a string without a `:`; such a candidate is left to the fallback.
var requestIPv4 = regexp.MustCompile(`^(?:(?:\d|[1-9]\d|1\d{2}|2[0-4]\d|25[0-5])\.){3}(?:\d|[1-9]\d|1\d{2}|2[0-4]\d|25[0-5])$`)

// errIPUncertain: request-ip's ipv6 regex would decide this candidate.
var errIPUncertain = fallback.New("client-ip")

// requestIPIs is request-ip's is.ip for a present value: true / false, or errIPUncertain when the
// answer depends on the ipv6 regex (the value holds a `:`).
func requestIPIs(v string) (bool, error) {
	if requestIPv4.MatchString(v) {
		return true, nil
	}
	if strings.Contains(v, ":") {
		return false, errIPUncertain
	}
	return false, nil
}

// requestIPHeaders are the headers request-ip's getClientIp reads after x-client-ip and
// x-forwarded-for, in its order.
var requestIPHeaders = []string{
	"cf-connecting-ip", "fastly-client-ip", "true-client-ip", "x-real-ip", "x-cluster-client-ip",
	"x-forwarded", "forwarded-for", "forwarded", "x-appengine-user-ip",
}

// resolveClientIP is resolveClientIp (src/server/utils/client-ip.ts): a trimmed CF-Connecting-IP
// that Node's net.isIP accepts, else request-ip's getClientIp, else 'unknown'. request-ip's last
// steps read the socket peer; reaching them falls back (the Node process's peer address and its
// IPv4-mapped form are not this process's to reproduce).
func resolveClientIP(r *Request) (string, error) {
	if cf, ok := r.Header("cf-connecting-ip"); ok {
		if c := jsvalue.Trim(cf); isIPAddress(c) {
			return c, nil
		}
	}
	if v, ok := r.Header("x-client-ip"); ok {
		is, err := requestIPIs(v)
		if err != nil {
			return "", err
		}
		if is {
			return v, nil
		}
	}
	if v, ok := r.Header("x-forwarded-for"); ok {
		for _, part := range strings.Split(v, ",") {
			ip := jsvalue.Trim(part)
			if strings.Contains(ip, ":") {
				if split := strings.Split(ip, ":"); len(split) == 2 {
					ip = split[0]
				}
			}
			is, err := requestIPIs(ip)
			if err != nil {
				return "", err
			}
			if is {
				return ip, nil
			}
		}
	}
	for _, h := range requestIPHeaders {
		v, ok := r.Header(h)
		if !ok {
			continue
		}
		is, err := requestIPIs(v)
		if err != nil {
			return "", err
		}
		if is {
			return v, nil
		}
	}
	return "", fallback.New("client-ip-socket")
}
