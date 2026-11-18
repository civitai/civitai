// Package apipolicy holds the facts of the app's API request policy (applyApiRequestPolicy,
// src/server/middleware/api-request-policy.ts) the public route reads: the default region block list,
// the user agents a verified crawler must carry, and the default API Cache-Control.
//
// apipolicy.json is generated from the Node modules by scripts/feed-go-api-policy.ts, and
// scripts/__tests__/feed-go-api-policy.schema-drift.test.ts fails when the two differ, so no list here is a
// transcription.
package apipolicy

import (
	_ "embed"
	"encoding/json"
	"regexp"
)

//go:embed apipolicy.json
var policyJSON []byte

// RegionBlock is one RegionBlockConfig entry (src/server/utils/region-blocking.ts).
type RegionBlock struct {
	Region        string `json:"region"`
	EffectiveDate string `json:"effectiveDate"` // YYYY-MM-DD, read as its end of day UTC
}

type botPattern struct {
	Name       string `json:"name"`
	Source     string `json:"source"`
	IgnoreCase bool   `json:"ignoreCase"`
}

var policy struct {
	RegionBlockDefault   []RegionBlock `json:"regionBlockDefault"`
	BotUserAgentPatterns []botPattern  `json:"botUserAgentPatterns"`
	PrivateCacheControl  string        `json:"privateCacheControl"`
}

var botPatterns []*regexp.Regexp

func init() {
	if err := json.Unmarshal(policyJSON, &policy); err != nil {
		panic("apipolicy: apipolicy.json: " + err.Error())
	}
	if len(policy.BotUserAgentPatterns) == 0 || policy.PrivateCacheControl == "" {
		panic("apipolicy: apipolicy.json is incomplete")
	}
	for _, p := range policy.BotUserAgentPatterns {
		src := p.Source
		if p.IgnoreCase {
			src = "(?i)" + src
		}
		botPatterns = append(botPatterns, regexp.MustCompile(src))
	}
}

// RegionBlockDefault is DEFAULT_REGION_BLOCK_CONFIG: the block list when REGION_BLOCK_CONFIG is unset.
func RegionBlockDefault() []RegionBlock {
	return append([]RegionBlock(nil), policy.RegionBlockDefault...)
}

// PrivateCacheControl is PRIVATE_CACHE_CONTROL (src/server/middleware/middleware-utils.ts).
func PrivateCacheControl() string { return policy.PrivateCacheControl }

// IsCrawlerUserAgent reports whether ua matches one of BOT_UA_PATTERNS (verify-bot.ts). verifyBot
// grants a request the verified-crawler header only when its user agent matches one of these (and its
// IP is in that crawler's published ranges), so a request that does not match can never be one.
func IsCrawlerUserAgent(ua string) bool {
	if ua == "" {
		return false
	}
	for _, re := range botPatterns {
		if re.MatchString(ua) {
			return true
		}
	}
	return false
}
