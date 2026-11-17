package modelfeed

import (
	"context"
)

// collectionPermissionSQL is the part of getUserCollectionPermissionsByIds
// (src/server/services/collection.service.ts) that decides `read` for one collection: its read
// configuration, its owner and, for a signed-in viewer, their contributor row. Node also joins the
// viewer's accepted invite, which only feeds `isCollaborator`; the contributor row is unique on
// (userId, collectionId), so leaving the invite out cannot change the row's read inputs. No
// contributor row reads as no permissions.
const (
	collectionPermissionSQL = `SELECT c.read::text, c."userId", '{}'::text[]
    FROM "Collection" c
    WHERE c.id = $1
    LIMIT 1`
	collectionPermissionViewerSQL = `SELECT c.read::text, c."userId", COALESCE(cc.permissions::text[], '{}')
    FROM "Collection" c
    LEFT JOIN "CollectionContributor" cc ON cc."collectionId" = c.id AND cc."userId" = $2
    WHERE c.id = $1
    LIMIT 1`
)

// collectionReadable is `getUserCollectionPermissionsById({ userId, id }).read` as getModelsRaw calls
// it: with no `isModerator`, so a moderator reads a collection only as any other viewer would. A
// collection reads when it is Public or Unlisted, when the viewer owns it, or when the viewer's
// contributor row grants VIEW; a collection that does not exist reads for no one. viewerID 0 is
// signed out.
func collectionReadable(ctx context.Context, db Querier, collectionID, viewerID int) (bool, error) {
	var (
		sql  = collectionPermissionSQL
		args = []any{collectionID}
	)
	if viewerID != 0 {
		sql, args = collectionPermissionViewerSQL, []any{collectionID, viewerID}
	}
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	if !rows.Next() {
		return false, rows.Err()
	}
	var (
		read    string
		ownerID int
		perms   []string
	)
	if err := rows.Scan(&read, &ownerID, &perms); err != nil {
		return false, err
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return readGranted(read, ownerID, perms, viewerID), nil
}

// readGranted is the `read` flag of getUserCollectionPermissionsByIds for one collection row, with no
// moderator branch. perms is the viewer's contributor permissions (empty: no contributor row, which
// grants nothing, as a row without VIEW grants no read).
func readGranted(read string, ownerID int, perms []string, viewerID int) bool {
	if read == "Public" || read == "Unlisted" {
		return true
	}
	if viewerID == 0 {
		return false
	}
	if viewerID == ownerID {
		return true
	}
	for _, p := range perms {
		if p == "VIEW" {
			return true
		}
	}
	return false
}

// collectionMemo holds one request's collection read decision: Node reads the permissions again on
// every page of the loop; this service reads them once, on the first page that reaches the check.
type collectionMemo struct {
	done, read bool
}
