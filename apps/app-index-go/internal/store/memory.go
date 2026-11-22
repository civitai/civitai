package store

import (
	"context"
	"maps"
	"sort"
	"strings"
	"sync"
)

// memGens is the generation half of an in-process store, over rows of type R, with the same
// transaction semantics as Postgres: every method changes a copy of the state and commits it whole,
// or not at all. Memory (the app index) and ListingsMemory (the listings read model) are built on
// it.
type memGens[R any] struct {
	mu   sync.Mutex
	gens map[int64]*memGen[R]
	next int64
	// row is an upsert's key and row.
	row func(Change) (string, R)

	// failBeforeCommit, when set, is called where the transaction would commit; an error aborts
	// it. Tests use it to stand in for a crash between a change and its commit.
	failBeforeCommit func(op string) error
}

type memGen[R any] struct {
	Generation
	rows map[string]R
}

func newMemGens[R any](row func(Change) (string, R)) memGens[R] {
	return memGens[R]{gens: map[int64]*memGen[R]{}, row: row}
}

// Memory is an in-process Store with the same transaction semantics as Postgres. Its text ranking
// differs from Postgres's ts_rank (a weighted count of the fields a word matched), so tests that pin
// a relevance ORDER run against Postgres; everything else is shared (contract_test.go).
type Memory struct {
	memGens[memApp]
}

type memApp struct {
	App
	nameKey string
}

// NewMemory returns an empty Memory store.
func NewMemory() *Memory {
	return &Memory{newMemGens(func(c Change) (string, memApp) {
		return c.App.URN, memApp{App: c.App, nameKey: nameKey(c.App.Name)}
	})}
}

func (m *memGens[R]) commit(op string) error {
	if m.failBeforeCommit != nil {
		return m.failBeforeCommit(op)
	}
	return nil
}

func (m *memGens[R]) find(state string) *memGen[R] {
	for _, g := range m.gens {
		if g.State == state {
			return g
		}
	}
	return nil
}

// Lock implements Generations. An in-process store belongs to one process, so the lock is always
// free.
func (m *memGens[R]) Lock(context.Context) (func(), error) { return func() {}, nil }

// Claim implements Generations.
func (m *memGens[R]) Claim(_ context.Context, gen int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.gens[gen]; !ok {
		return ErrNoGeneration
	}
	return nil
}

// State implements Generations.
func (m *memGens[R]) State(context.Context) (State, error) {
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

// NewBuilding implements Generations.
func (m *memGens[R]) NewBuilding(_ context.Context, schema string, layout int) (Generation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.commit("new-building"); err != nil {
		return Generation{}, err
	}
	if g := m.find(StateBuilding); g != nil {
		delete(m.gens, g.ID)
	}
	m.next++
	g := &memGen[R]{Generation: Generation{ID: m.next, Layout: layout, Schema: schema, State: StateBuilding}, rows: map[string]R{}}
	m.gens[g.ID] = g
	return g.Generation, nil
}

// Reset implements Generations.
func (m *memGens[R]) Reset(_ context.Context, gen int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.gens[gen]
	if !ok {
		return ErrNoGeneration
	}
	if err := m.commit("reset"); err != nil {
		return err
	}
	g.rows = map[string]R{}
	g.Cursor = ""
	return nil
}

// Apply implements Generations.
func (m *memGens[R]) Apply(_ context.Context, gen int64, c Change) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	g, ok := m.gens[gen]
	if !ok {
		return ErrNoGeneration
	}
	// The change and its cursor are staged together and committed together.
	rows := g.rows
	switch c.Kind {
	case ChangeUpsert:
		rows = maps.Clone(g.rows)
		k, r := m.row(c)
		rows[k] = r
	case ChangeDelete:
		if _, ok := g.rows[c.URN]; ok {
			rows = maps.Clone(g.rows)
			delete(rows, c.URN)
		}
	case ChangeProgress:
	}
	if err := m.commit("apply"); err != nil {
		return err
	}
	g.rows = rows
	g.Cursor = c.Cursor
	return nil
}

// Live implements Generations.
func (m *memGens[R]) Live(_ context.Context, gen int64, cursor string) (bool, error) {
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
	type hit struct {
		a    memApp
		rank float64
	}
	var hits []hit
	for _, a := range g.rows {
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
	sort.Slice(hits, func(i, j int) bool {
		x, y := hits[i], hits[j]
		if x.rank != y.rank {
			return x.rank > y.rank
		}
		if x.a.nameKey != y.a.nameKey {
			return x.a.nameKey < y.a.nameKey
		}
		return x.a.URN < y.a.URN
	})
	var page Page
	for i := 0; i < len(hits) && i < q.limitOf(); i++ {
		page.Results = append(page.Results, resultOf(hits[i].a.App))
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
