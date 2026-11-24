package modelfeed

// PersonalHotLeadEligible reports whether Node would evaluate the `personal-hot-lead` flag for this
// input and shape the page with its answer: getPersonalLeadIdsForFeed
// (src/server/controllers/model.controller.ts), on ANY page. Page 1 leads with the viewer's picks;
// every later page drops the ids of the viewer's cached lead from the stream, so a later page this
// service served would differ too. Node also requires a signed-in session or full-scope user key
// (every viewer this service resolves is one) and a browsing level; the level is not checked here,
// so a request Node would refuse the lead for lack of one is a superset this side can only
// over-report (and over-reporting costs a fallback, never a page that differs from Node's).
//
// query and hidden are not checked either: Parse already falls back on each. `followed` (truthy) and
// a non-empty `ids` (`input.ids?.length`: an empty list keeps the lead) are, for when their ports
// read them.
//
// Temporary: it exists for the model-getall-personal-hot-lead fallback until the experiment is
// decided (DESIGN.md §15.2.3).
func (in *Input) PersonalHotLeadEligible() bool {
	return in.Sort == SortHot &&
		in.Username == "" && in.User == "" && in.CollectionID == 0 && !in.Favorites && !in.Archived &&
		!in.Followed && len(in.IDs) == 0
}
