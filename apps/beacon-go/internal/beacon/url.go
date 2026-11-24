package beacon

import (
	"strconv"
	"strings"
)

// urlHostResult is what `new URL(s).host` gives for one input, as far as this service can tell.
type urlHostResult uint8

const (
	urlHost      urlHostResult = iota // parsed; the host is known exactly
	urlThrows                         // `new URL` throws (a TypeError the handler catches)
	urlUncertain                      // outside the subset reproduced here: fall back
)

// urlHostOf reproduces `new URL(s).host` (WHATWG URL, as Node's Ada parser implements it) for the
// inputs beacons actually carry — an http(s) Referer or Origin — and says "uncertain" for every
// input whose answer would need the parts of the standard not reproduced here: other schemes,
// userinfo, IPv6 and IPv4-number hosts, percent-encoded or IDNA hosts, and any character the parser
// strips or remaps (controls, spaces, non-ASCII, backslash).
//
// Within the subset the answer is exact: the scheme and host are lowercased; an empty port, and a
// port equal to the scheme's default, are dropped; leading zeros of a port are dropped; a port past
// 65535 or holding a non-digit throws, as does an empty host or a missing scheme.
func urlHostOf(s string) (string, urlHostResult) {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c <= 0x20 || c >= 0x7F || c == '\\' {
			return "", urlUncertain
		}
	}
	// Scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":". Without one there is no base URL to
	// resolve against, which throws.
	colon := -1
	for i := 0; i < len(s); i++ {
		c := s[i]
		isAlpha := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
		if i == 0 && !isAlpha {
			return "", urlThrows
		}
		if c == ':' {
			colon = i
			break
		}
		if !isAlpha && !isDigitByte(c) && c != '+' && c != '-' && c != '.' {
			return "", urlThrows
		}
	}
	if colon <= 0 {
		return "", urlThrows
	}
	scheme := strings.ToLower(s[:colon])
	var defaultPort string
	switch scheme {
	case "http":
		defaultPort = "80"
	case "https":
		defaultPort = "443"
	default:
		return "", urlUncertain
	}
	rest := s[colon+1:]
	// Exactly two slashes then the authority. (The standard also accepts one, three or none for a
	// special scheme; those are left to the fallback.)
	if !strings.HasPrefix(rest, "//") || (len(rest) > 2 && rest[2] == '/') {
		return "", urlUncertain
	}
	rest = rest[2:]
	end := strings.IndexAny(rest, "/?#")
	if end < 0 {
		end = len(rest)
	}
	authority := rest[:end]
	if strings.ContainsAny(authority, "@[]%") {
		return "", urlUncertain
	}
	host, port, hasPort := strings.Cut(authority, ":")
	if host == "" {
		return "", urlThrows
	}
	if hasPort {
		if port != "" {
			for i := 0; i < len(port); i++ {
				if port[i] < '0' || port[i] > '9' {
					return "", urlThrows
				}
			}
			trimmed := strings.TrimLeft(port, "0")
			if len(trimmed) > 5 {
				return "", urlThrows
			}
			n, _ := strconv.Atoi("0" + trimmed)
			if n > 65535 {
				return "", urlThrows
			}
			port = strconv.Itoa(n)
		}
	}
	host = strings.ToLower(host)
	labels := strings.Split(host, ".")
	last := len(labels) - 1
	if labels[last] == "" && last > 0 {
		last-- // one trailing dot is kept in the serialization and ignored for the number check
	}
	for i, l := range labels {
		if l == "" && i != len(labels)-1 {
			return "", urlUncertain // an empty label (leading dot, `..`)
		}
		if strings.HasPrefix(l, "xn--") {
			return "", urlUncertain // punycode: decoded and validated by IDNA
		}
		for j := 0; j < len(l); j++ {
			c := l[j]
			if !isLowerAlnum(c) && c != '-' && c != '_' {
				return "", urlUncertain
			}
		}
	}
	// "Ends in a number": the host is then parsed as an IPv4 address (decimal, octal or hex parts).
	if l := labels[last]; l != "" && (isDigits(l) || strings.HasPrefix(l, "0x")) {
		return "", urlUncertain
	}
	if hasPort && port != "" && port != defaultPort {
		return host + ":" + port, urlHost
	}
	return host, urlHost
}

func isDigitByte(c byte) bool { return c >= '0' && c <= '9' }

func isLowerAlnum(c byte) bool { return (c >= 'a' && c <= 'z') || isDigitByte(c) }
