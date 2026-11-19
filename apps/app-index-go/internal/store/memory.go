package store

import (
	"context"
	"sort"
	"strings"
	"sync"
	"time"
)

// Memory is an in-process Store with the same transaction semantics as Postgres: every method
// changes a copy of the state and commits it whole, or not at all. Its text ranking differs from
// Postgres's ts_rank (a weighted count of the fields a word matched), so tests that pin a
// relevance ORDER run against Postgres; everything else is shared (contract_test.go).
type Memory struct {
	mu   sync.Mutex
	gens map[int64]*memGen
	next int64
	now  func() time.Time

	// failBeforeCommit, when set, is called where the transaction would commit; an error aborts
	// it. Tests use it to stand in for a crash between a change and its commit.
	failBeforeCommit func(op string) error
}

type memGen struct {
	Generation
	apps map[string]memApp
}

type memApp struct {
	App
	nameKey string
	seen    int64
}

// NewMemory returns an empty Memory store.
func NewMemory() *Memory {
	return &Memory{gens: map[int64]*memGen{}, now: time.Now}
}

func (m *Memory) commit(op string) error {
	if m.failBeforeCommit != nil {
		return m.failBeforeCommit(op)
	}
	return nil
}

func (m *Memory) find(state string) *memGen {
	for _, g := range m.gens {
		if g.State == state {
			return g
		}
	}
	return nil
}

// Lock implements Store. A Memory store belongs to one process, so the lock is always free.
func (m *Memory) Lock(context.Context) (func(), error) { return func() {}, nil }

// Claim implements Store.
func (m *Memory) Claim(_ context.Context, gen int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.gens[gen]; !ok {
		return ErrNoGeneration
	}
	return nil
}

// State implements Store.
func (m *Memory) State(context.Context) (State, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var st State
	if g := m.find(StateServing); g != nil {
		c := g.Generation
		st.Serving = &c
	}
	if g := m.find(StateBuilding); g != nil {
		c := g.Generation
		st.Building = &c
	}
	return st, nil
}

// NewBuilding implements Store.
func (m *Memory) NewBuilding(_ context.Context, schema string, layout int) (Generation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.commit("new-building"); err != nil {
		return Generation{}, err
	}
	if g := m.find(StateBuilding); g != nil {
		delete(m.gens, g.ID)
	}
	m.next++
	g := &memGen{Generation: Generation{ID: m.next, Layout: layout, Schema: schema, State: StateBuilding}, apps: map[string]memApp{}}
	m.gens[g.ID] = g
	return g.Generation, nil
}

// Reset implements Store.
func (m *Memory) Reset(_ context.Context, gen int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.gens[gen]
	if !ok {
		return ErrNoGeneration
	}
	if err := m.commit("reset"); err != nil {
		return err
	}
	g.apps = map[string]memApp{}
	g.Cursor = ""
	return nil
}

// Apply implements Store.
func (m *Memory) Apply(_ context.Context, gen int64, c Change) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.gens[gen]
	if !ok {
		return ErrNoGeneration
	}
	// The change and its cursor are staged together and committed together.
	apps := g.apps
	switch c.Kind {
	case ChangeUpsert:
		seen := m.now().UnixMicro()
		if old, ok := g.apps[c.App.URN]; ok {
			seen = old.seen
		} else if s := m.find(StateServing); s != nil && s != g {
			if old, ok := s.apps[c.App.URN]; ok {
				seen = old.seen
			}
		}
		apps = cloneApps(g.apps)
		apps[c.App.URN] = memApp{App: c.App, nameKey: nameKey(c.App.Name), seen: seen}
	case ChangeDelete:
		if _, ok := g.apps[c.URN]; ok {
			apps = cloneApps(g.apps)
			delete(apps, c.URN)
		}
	case ChangeProgress:
	}
	if err := m.commit("apply"); err != nil {
		return err
	}
	g.apps = apps
	g.Cursor = c.Cursor
	return nil
}

func cloneApps(in map[string]memApp) map[string]memApp {
	out := make(map[string]memApp, len(in)+1)
	for k, v := range in {
		out[k] = v
	}
	return out
}

// Live implements Store.
func (m *Memory) Live(_ context.Context, gen int64, cursor string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.gens[gen]
	if !ok {
		return false, ErrNoGeneration
	}
	if err := m.commit("live"); err != nil {
		return false, err
	}
	g.Cursor = cursor
	if g.State != StateBuilding {
		return false, nil
	}
	if old := m.find(StateServing); old != nil {
		delete(m.gens, old.ID)
	}
	g.State = StateServing
	return true, nil
}

// Search implements Store.
func (m *Memory) Search(_ context.Context, q Query) (Page, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	g := m.find(StateServing)
	if g == nil {
		return Page{}, ErrNotReady
	}
	tokens := Tokens(q.Text)
	if strings.TrimSpace(q.Text) != "" && len(tokens) == 0 {
		return Page{}, nil
	}
	sortBy := q.effectiveSort()
	type hit struct {
		a    memApp
		rank float64
	}
	var hits []hit
	for _, a := range g.apps {
		if q.Kind != "" && a.Kind != q.Kind {
			continue
		}
		if q.Category != "" && a.Category != q.Category {
			continue
		}
		rank, ok := memRank(a.App, tokens)
		if !ok {
			continue
		}
		hits = append(hits, hit{a, rank})
	}
	less := func(x, y hit) bool {
		switch sortBy {
		case SortRelevance:
			if x.rank != y.rank {
				return x.rank > y.rank
			}
			if x.a.nameKey != y.a.nameKey {
				return x.a.nameKey < y.a.nameKey
			}
			return x.a.URN < y.a.URN
		case SortNewest:
			if x.a.seen != y.a.seen {
				return x.a.seen > y.a.seen
			}
			return x.a.URN > y.a.URN
		default:
			if x.a.nameKey != y.a.nameKey {
				return x.a.nameKey < y.a.nameKey
			}
			return x.a.URN < y.a.URN
		}
	}
	sort.Slice(hits, func(i, j int) bool { return less(hits[i], hits[j]) })
	keyOf := func(h hit) Key {
		switch sortBy {
		case SortRelevance:
			return Key{Rank: h.rank, Name: h.a.nameKey, URN: h.a.URN}
		case SortNewest:
			return Key{Seen: h.a.seen, URN: h.a.URN}
		default:
			return Key{Name: h.a.nameKey, URN: h.a.URN}
		}
	}
	start := 0
	if q.After != nil {
		after := hit{a: memApp{App: App{URN: q.After.URN}, nameKey: q.After.Name, seen: q.After.Seen}, rank: q.After.Rank}
		start = sort.Search(len(hits), func(i int) bool { return less(after, hits[i]) })
	}
	limit := q.Limit
	if limit <= 0 {
		limit = 20
	}
	var page Page
	for i := start; i < len(hits) && len(page.Results) < limit; i++ {
		page.Results = append(page.Results, resultOf(hits[i].a.App))
		if len(page.Results) == limit && i+1 < len(hits) {
			k := keyOf(hits[i])
			page.Next = &k
		}
	}
	return page, nil
}

// memRank: every token must prefix a word of a searched field; the rank is the sum of the weights
// of the fields that matched any token (name 1, slug and tagline 0.4, creator 0.2).
func memRank(a App, tokens []string) (float64, bool) {
	if len(tokens) == 0 {
		return 0, true
	}
	fields := []struct {
		text   string
		weight float64
	}{{a.Name, 1}, {a.Slug, 0.4}, {a.Tagline, 0.4}, {a.Creator, 0.2}}
	words := make([][]string, len(fields))
	for i, f := range fields {
		words[i] = wordRE.FindAllString(strings.ToLower(f.text), -1)
	}
	matched := make([]bool, len(fields))
	for _, t := range tokens {
		found := false
		for i := range fields {
			for _, w := range words[i] {
				if strings.HasPrefix(w, t) {
					matched[i] = true
					found = true
					break
				}
			}
		}
		if !found {
			return 0, false
		}
	}
	rank := 0.0
	for i, f := range fields {
		if matched[i] {
			rank += f.weight
		}
	}
	return rank, true
}

func resultOf(a App) Result {
	return Result{URN: a.URN, Slug: a.Slug, Name: a.Name, Tagline: a.Tagline, Kind: a.Kind,
		Category: a.Category, Rating: a.Rating, IconURL: a.IconURL, Creator: a.Creator}
}
