package modelfeed

// PersonalHotLeadEligible reports whether Node would evaluate the `personal-hot-lead` flag for this
// input AND lead the page with its answer: getPersonalLeadIdsForFeed
// (src/server/controllers/model.controller.ts) on the first page (no cursor). Node also requires a
// signed-in session or full-scope user key (every viewer this service resolves is one) and a
// browsing level; the level is not checked here, so a request Node would refuse the lead for
// lack of one is a superset this side can only over-report (and over-reporting costs a fallback,
// never a page without the lead).
//
// query, hidden, followed and ids are not checked either: Parse already falls back on each.
//
// Temporary: it exists for the model-getall-personal-hot-lead fallback until the experiment is
// decided (DESIGN.md §15.2.3).
func (in *Input) PersonalHotLeadEligible() bool {
	return in.Sort == SortHot && in.Cursor == "" &&
		in.Username == "" && in.User == "" && in.CollectionID == 0 && !in.Favorites && !in.Archived
}
