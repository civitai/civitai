// Package evalharness replays the production-derived eval corpus (DESIGN.md §19.8): `feed-eval run`
// sends each selected case to the Node app and to feed-go (in eval mode) as a sandwich, Node, Go,
// Node, and scores Go's answer against Node's with the comparison production uses
// (server.CompareSelection); `feed-eval publish` renders the runs as static pages.
//
// The Node app is the oracle: a case it cannot answer twice the same way is the corpus's or the
// environment's problem (infra_miss, node_unstable), never Go's. Go's hand-back stub (status 599 and
// X-Feed-Go-Handback-Reason, DESIGN.md §19.7) is a gap; any other Go failure is an error; a Go answer
// that matches neither Node answer is a bug.
//
// Nothing here runs unless a subcommand invokes it. What it publishes holds no request input, no
// response body and no account: only endpoints, verdicts, reasons, diff categories, paths, opaque case
// ids and signatures (publish.go).
package evalharness

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/civitai/civitai/apps/feed-go/internal/evalcapture"
)

// Verdicts: the `results.verdict` values. Every case a run takes ends in exactly one.
const (
	// VerdictPass: Go's answer matched one of the two Node answers (body after masks, compared
	// headers, status).
	VerdictPass = "pass"
	// VerdictBug: Go answered and matched neither Node answer.
	VerdictBug = "bug"
	// VerdictGap: Go handed the request back (the eval-mode stub); reason is the hand-back reason.
	VerdictGap = "gap"
	// VerdictError: Go failed otherwise (a 5xx that is not the stub, a timeout, a transport error).
	VerdictError = "error"
	// VerdictNodeUnstable: Node's two answers differ after the endpoint's masks.
	VerdictNodeUnstable = "node_unstable"
	// VerdictNotReplayable: the case cannot be replayed here (a moderator or banned viewer, a missing
	// or expired eval account, an input the replay cannot rebuild).
	VerdictNotReplayable = "not_replayable"
	// VerdictInfraMiss: the environment, not the case: either Node call failed (transport, timeout,
	// 5xx, no status), the two Node statuses differ (a 200 then a 404 included), a Node 200 tRPC answer
	// is not a tRPC result, or the run was cancelled while the case was in flight (reason `canceled`).
	VerdictInfraMiss = "infra_miss"
)

// Verdicts is every verdict, in report order.
var Verdicts = []string{VerdictPass, VerdictBug, VerdictGap, VerdictError, VerdictNodeUnstable, VerdictNotReplayable, VerdictInfraMiss}

// PhaseLive is the `runs.phase` of a run against a live Node app (the only phase today; a frozen
// replay against Node's recorded answers is a later change).
const PhaseLive = "live"

// Case is one corpus case a run replays: the exemplar of its signature for the run's day.
type Case struct {
	ID       uint64
	Endpoint string
	Sig      uint64
	// SigText is the case's canonical shape (no values): read for `"$envelope":"invalid"`, a tRPC
	// input that was not stored because it did not decode.
	SigText string
	Request evalcapture.StoredRequest
	// Weight is the signature's traffic weight over the lookback (sum of samples.weight).
	Weight float64
}

// reasonRE is what a reason, a category or a path may hold once written: letters, digits and the
// punctuation of paths and categories. Anything else is replaced (safeToken), so a stray value can
// never reach a row or a page through one of them.
var reasonRE = regexp.MustCompile(`^[A-Za-z0-9_.:*\[\]$+-]{1,128}$`)

// Redacted replaces a token that is not reasonRE.
const Redacted = "(redacted)"

// safeToken is s when it is reasonRE, else Redacted.
func safeToken(s string) string {
	if reasonRE.MatchString(s) {
		return s
	}
	return Redacted
}

// safeTokens is safeToken over a list, duplicates dropped, order kept.
func safeTokens(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, s := range in {
		s = safeToken(s)
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// HexID is an id as the pages show it: 16 lowercase hex digits.
func HexID(id uint64) string {
	s := strconv.FormatUint(id, 16)
	return strings.Repeat("0", 16-len(s)) + s
}
