package hydrate

import (
	"context"
	"fmt"
)

// The part of getUserCollectionPermissionsByIds (src/server/services/collection.service.ts) that
// decides `read`, as image.getInfinite's `collectionId` reads it (getUserCollectionPermissionsById,
// on the replica as Node's dbRead): the collection's `read` configuration, its owner, and the
// viewer's CollectionContributor permissions. Node also joins the viewer's accepted CollectionInvite,
// which only feeds isCollaborator, so it is not read here.
const (
	sqlCollectionPermission = `SELECT c.read::text, c."userId", '{}'::text[]
    FROM "Collection" c
    WHERE c.id = $1
    LIMIT 1`
	sqlCollectionPermissionViewer = `SELECT c.read::text, c."userId", COALESCE(cc.permissions::text[], '{}')
    FROM "Collection" c
    LEFT JOIN "CollectionContributor" cc ON cc."collectionId" = c.id AND cc."userId" = $2
    WHERE c.id = $1
    LIMIT 1`
)

// CollectionPermission is one collection's row for the read decision: its `read` configuration
// (Public, Unlisted, Private), its owner's id, and the viewer's contributor permissions (empty
// without a contributor row, or signed out).
type CollectionPermission struct {
	Read         string
	OwnerID      int
	Contributor  []string
	CollectionID int
}

// CollectionPermission reads collectionID's row for the viewer (viewerID 0: signed out, no
// contributor join, as Node's query without a userId). A collection that does not exist is nil.
func (s *Sources) CollectionPermission(ctx context.Context, collectionID, viewerID int) (*CollectionPermission, error) {
	sql, args := sqlCollectionPermission, []any{collectionID}
	if viewerID != 0 {
		sql, args = sqlCollectionPermissionViewer, []any{collectionID, viewerID}
	}
	rows, err := s.Replica.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("collection permission: %w", err)
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	p := &CollectionPermission{CollectionID: collectionID}
	if err := rows.Scan(&p.Read, &p.OwnerID, &p.Contributor); err != nil {
		return nil, fmt.Errorf("collection permission: %w", err)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("collection permission: %w", err)
	}
	return p, nil
}
