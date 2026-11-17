package beacon

import "strings"

// pathnames is pathnamesTokens in src/shared/constants/pathname.constants.ts, in its order (the
// order is load-bearing: the first exact match wins, and the LAST soft match wins). Comic routes are
// deliberately absent there; see that file. A test pins this list against that file.
var pathnames = []string{
	"/moderator/test",
	"/404",
	"/air/confirm",
	"/collections/[collectionId]/review",
	"/creator-program",
	"/content/dmca-notice",
	"/content/dmca-counter-notice",
	"/dmca/notice",
	"/games/chopped",
	"/home",
	"/images",
	"/models/[id]/edit",
	"/models/[id]/model-versions/[versionId]/edit",
	"/models",
	"/payment/success",
	"/posts",
	"/product/odor",
	"/product/vault",
	"/search/articles",
	"/search/bounties",
	"/search/collections",
	"/search/models",
	"/search/users",
	"/subscribe/[plan]",
	"/support",
	"/testing/demo",
	"/testing/metadata-test",
	"/user/[username]/[list]",
	"/user/[username]/images",
	"/user/[username]/models",
	"/user/[username]/posts",
	"/user/[username]/videos",
	"/user/downloads",
	"/user/notifications",
	"/videos",
	"/articles/[id]/edit",
	"/articles",
	"/bounties/[id]/edit",
	"/articles/create",
	"/articles/[id]/[[...slug]]",
	"/bounties/[id]/entries/[entryId]/edit",
	"/bounties/[id]/entries/create",
	"/bounties/entries/[entryId]",
	"/bounties/create",
	"/bounties",
	"/claim/buzz/[id]",
	"/builds",
	"/claim/cosmetic/[id]",
	"/bounties/[id]/entries/[entryId]",
	"/bounties/[id]/[[...slug]]",
	"/collections/[collectionId]",
	"/collections",
	"/content/[[...slug]]",
	"/discord/link-role",
	"/comments/[id]",
	"/comments/v2/[id]",
	"/images/[imageId]",
	"/",
	"/generate",
	"/intent/avatar",
	"/intent/post",
	"/login",
	"/model-versions/[id]",
	"/leaderboard/[id]",
	"/models/[id]/model-versions/create",
	"/models/[id]/model-versions/[versionId]/wizard",
	"/models/[id]/wizard",
	"/models/create",
	"/models/license/[versionId]",
	"/models/train",
	"/events/[slug]",
	"/models/[id]/reviews",
	"/posts/[postId]/[[...postSlug]]",
	"/posts/[postId]/edit",
	"/payment/paddle",
	"/newsroom",
	"/posts/create",
	"/product/link",
	"/pricing",
	"/purchase/buzz",
	"/models/[id]/[[...slug]]",
	"/reviews/[reviewId]",
	"/search/images",
	"/safety",
	"/tag/[tagname]",
	"/shop",
	"/user/[username]/articles",
	"/user/[username]/collections",
	"/user/[username]",
	"/user/account",
	"/user/account/[[...section]]",
	"/games/knights-of-new-order",
	"/user/earn-potential",
	"/user/[username]/manage-categories",
	"/user/stripe-connect/onboard",
	"/user/buzz-dashboard",
	"/user/membership",
	"/user/transactions",
	"/user/vault",
}

var pathnameTokens = func() [][]string {
	out := make([][]string, len(pathnames))
	for i, p := range pathnames {
		out[i] = strings.Split(strings.TrimPrefix(p, "/"), "/")
	}
	return out
}()

// matchingPathname is getMatchingPathname(url): the first pathname whose tokens the url's tokens
// equal position by position (a url SHORTER than the pathname matches its prefix, as the JS
// `every` over the url's tokens does), else the last soft match (same length, or the length without
// optional `[[...]]` tokens, with `[`-tokens as wildcards), else the url itself.
func matchingPathname(url string) string {
	urlTokens := strings.Split(strings.TrimPrefix(url, "/"), "/")
	match, found := "", false
	for i, tokens := range pathnameTokens {
		exact := true
		for j, t := range urlTokens {
			if j >= len(tokens) || t != tokens[j] {
				exact = false
				break
			}
		}
		if exact {
			return pathnames[i]
		}
		soft := 0
		for _, t := range tokens {
			if !strings.Contains(t, "[[") {
				soft++
			}
		}
		// The length test sits inside the JS `every` callback, so it is asked per token; urlTokens is
		// never empty, so asking it once is the same.
		softMatch := len(tokens) == len(urlTokens) || soft == len(urlTokens)
		for j, t := range urlTokens {
			if !softMatch {
				break
			}
			softMatch = j < len(tokens) && (t == tokens[j] || strings.HasPrefix(tokens[j], "["))
		}
		if softMatch {
			match, found = pathnames[i], true
		}
	}
	if found {
		return match
	}
	return url
}
