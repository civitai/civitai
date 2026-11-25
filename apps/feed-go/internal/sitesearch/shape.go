package sitesearch

// The per-viewer hit shaping of site-search.service.ts (shapeHits and the per-index shape functions),
// over raw hits. A hit that is not an object on an index that shapes, or a value a rule reads that is
// not of a kind this port reads as Node does, is errShape: the request falls back, and Node answers it.

// ratingWithinCap is isRatingWithinCap (src/shared/utils/rating-cap.ts) for a rating read off a hit:
// `Number(level) || 0`, then not 0 and every bit inside the cap (Flags.hasFlag). present is false for
// an absent rating (Number(undefined) is NaN, so 0).
func ratingWithinCap(raw []byte, present bool, cap int) (bool, error) {
	if !present {
		return false, nil
	}
	f, ok := jsNumber(raw)
	if !ok {
		return false, errShape
	}
	rating, ok := int32Of(f)
	if !ok {
		return false, errShape
	}
	return rating != 0 && int32(cap)|rating == int32(cap), nil //nolint:gosec // G115: cap is a browsing level (at most 63)
}

// imageWithinCap is `isRatingWithinCap(image?.nsfwLevel, cap)` for one element of an images list: an
// element that is not an object has no rating, so it is outside.
func imageWithinCap(image []byte, cap int) (bool, error) {
	if !isObject(image) {
		return false, nil
	}
	o, err := parseObject(image)
	if err != nil {
		return false, err
	}
	level, present := o.get("nsfwLevel")
	return ratingWithinCap(level, present, cap)
}

// capImages drops the images the site may not serve: unchanged without a cap; a value that is not a
// list becomes [] under a cap (its ratings cannot be read).
func capImages(images []byte, cap int) ([]byte, error) {
	if cap == 0 {
		return images, nil
	}
	if !isArray(images) {
		return rawEmptyArray, nil
	}
	elems, err := parseArray(images)
	if err != nil {
		return nil, err
	}
	kept := elems[:0:0]
	for _, e := range elems {
		ok, err := imageWithinCap(e, cap)
		if err != nil {
			return nil, err
		}
		if ok {
			kept = append(kept, e)
		}
	}
	if len(kept) == len(elems) {
		return images, nil
	}
	return appendArray(nil, kept), nil
}

// imageID is `image?.id` as a key for keepCopiesOf: String(id), and whether the id is not null or
// undefined (`image?.id != null`).
func imageID(image []byte) (string, bool, error) {
	if !isObject(image) {
		return "", false, nil
	}
	o, err := parseObject(image)
	if err != nil {
		return "", false, err
	}
	id, ok := o.get("id")
	if !ok || isNull(id) {
		return "", false, nil
	}
	s, ok := jsString(id)
	if !ok {
		return "", false, errShape
	}
	return s, true, nil
}

// keepCopiesOf is the highlight copy's images that the hit itself kept, matched by String(id) (the
// copy's numbers come as strings); not a list is [].
func keepCopiesOf(copies, kept []byte, keptPresent bool) ([]byte, error) {
	if !isArray(copies) {
		return rawEmptyArray, nil
	}
	ids := map[string]bool{}
	if keptPresent && isArray(kept) {
		elems, err := parseArray(kept)
		if err != nil {
			return nil, err
		}
		for _, e := range elems {
			id, ok, err := imageID(e)
			if err != nil {
				return nil, err
			}
			if ok {
				ids[id] = true
			}
		}
	}
	elems, err := parseArray(copies)
	if err != nil {
		return nil, err
	}
	out := elems[:0:0]
	for _, e := range elems {
		id, ok, err := imageID(e)
		if err != nil {
			return nil, err
		}
		if ok && ids[id] {
			out = append(out, e)
		}
	}
	return appendArray(nil, out), nil
}

// shapeModelHit is shapeModelHit: `sfwName` is never sent; a viewer who gets the civitai.com face gets
// it as `name` (only where the hit carries `name`), the highlight copy too; under a cap the images are
// capped, and the copy keeps only the images the hit kept.
func shapeModelHit(hit *object, v Viewer) error {
	sfwName, hasSfw := hit.get("sfwName")
	hit.del("sfwName")
	useFace := v.ShowSfwFace && hasSfw && isString(sfwName) && string(sfwName) != `""`
	if useFace && hit.has("name") {
		hit.set("name", sfwName)
	}
	images, hasImages := hit.get("images")
	if hasImages {
		capped, err := capImages(images, v.Cap)
		if err != nil {
			return err
		}
		hit.set("images", capped)
		images = capped
	}
	formattedRaw, ok := hit.get("_formatted")
	if !ok || !truthy(formattedRaw) {
		return nil
	}
	if !isObject(formattedRaw) {
		return errShape
	}
	formatted, err := parseObject(formattedRaw)
	if err != nil {
		return err
	}
	fSfw, hasFSfw := formatted.get("sfwName")
	formatted.del("sfwName")
	if useFace && formatted.has("name") {
		// `formattedSfwName ?? sfwName`
		name := sfwName
		if hasFSfw && !isNull(fSfw) {
			name = fSfw
		}
		formatted.set("name", name)
	}
	if copies, ok := formatted.get("images"); ok && v.Cap != 0 {
		kept, err := keepCopiesOf(copies, images, hasImages)
		if err != nil {
			return err
		}
		formatted.set("images", kept)
	}
	hit.set("_formatted", formatted.bytes())
	return nil
}

// shapeComicHit is shapeComicHit: under a cap a comic keeps its cover only when every level the cover
// carries is inside the cap; an unrated cover counts as outside. Otherwise `coverImageUrl` is removed
// from the hit and its highlight copy.
func shapeComicHit(hit *object, cap int) error {
	if cap == 0 {
		return nil
	}
	var level int32
	if raw, ok := hit.get("coverImageNsfwLevel"); ok {
		f, ok := jsNumber(raw)
		if !ok {
			return errShape
		}
		l, ok := int32Of(f)
		if !ok {
			return errShape
		}
		level = l
	}
	if level > 0 && level&^int32(cap) == 0 { //nolint:gosec // G115: cap is a browsing level (at most 63)
		return nil
	}
	hit.del("coverImageUrl")
	formattedRaw, ok := hit.get("_formatted")
	if !ok || !truthy(formattedRaw) {
		return nil
	}
	if !isObject(formattedRaw) {
		return errShape
	}
	formatted, err := parseObject(formattedRaw)
	if err != nil {
		return err
	}
	formatted.del("coverImageUrl")
	hit.set("_formatted", formatted.bytes())
	return nil
}

// shapeBountyHit is shapeBountyHit: under a cap each image is capped (a bounty's own level passes when
// any one image does), and the highlight copy keeps only the images the hit kept.
func shapeBountyHit(hit *object, cap int) error {
	if cap == 0 {
		return nil
	}
	images, hasImages := hit.get("images")
	if hasImages {
		capped, err := capImages(images, cap)
		if err != nil {
			return err
		}
		hit.set("images", capped)
		images = capped
	}
	formattedRaw, ok := hit.get("_formatted")
	if !ok || !truthy(formattedRaw) {
		return nil
	}
	// `'images' in shaped._formatted` throws on a primitive: Node answers a 500.
	if !isObject(formattedRaw) {
		return errShape
	}
	formatted, err := parseObject(formattedRaw)
	if err != nil {
		return err
	}
	copies, ok := formatted.get("images")
	if !ok {
		return nil
	}
	kept, err := keepCopiesOf(copies, images, hasImages)
	if err != nil {
		return err
	}
	formatted.set("images", kept)
	hit.set("_formatted", formatted.bytes())
	return nil
}

// shapeCollectionHit is shapeCollectionHit with level (the cap, or the collection image level where
// the site caps nothing): `srcs` (unrated) is dropped unless keepSrcs, which moves it to the end of the
// object; the item images are capped; a cover outside the level becomes null, and so does the
// highlight copy's.
func shapeCollectionHit(hit *object, level int, keepSrcs bool) error {
	if level == 0 {
		return nil
	}
	srcs, hasSrcs := hit.get("srcs")
	hit.del("srcs")
	if keepSrcs && hasSrcs {
		hit.set("srcs", srcs)
	}
	images, hasImages := hit.get("images")
	if hasImages {
		capped, err := capImages(images, level)
		if err != nil {
			return err
		}
		hit.set("images", capped)
		images = capped
	}
	cover, hasCover := hit.get("image")
	coverKept := false
	if hasCover && truthy(cover) {
		// `cover.nsfwLevel`: a cover that is not an object has no rating.
		if isObject(cover) {
			c, err := parseObject(cover)
			if err != nil {
				return err
			}
			level2, present := c.get("nsfwLevel")
			if coverKept, err = ratingWithinCap(level2, present, level); err != nil {
				return err
			}
		}
		if !coverKept {
			hit.set("image", rawNull)
		}
	}
	formattedRaw, ok := hit.get("_formatted")
	if !ok || !truthy(formattedRaw) {
		return nil
	}
	if !isObject(formattedRaw) {
		return errShape
	}
	formatted, err := parseObject(formattedRaw)
	if err != nil {
		return err
	}
	fSrcs, hasFSrcs := formatted.get("srcs")
	formatted.del("srcs")
	if keepSrcs && hasFSrcs {
		formatted.set("srcs", fSrcs)
	}
	if copies, ok := formatted.get("images"); ok {
		kept, err := keepCopiesOf(copies, images, hasImages)
		if err != nil {
			return err
		}
		formatted.set("images", kept)
	}
	if fImage, ok := formatted.get("image"); ok && truthy(fImage) && !coverKept {
		formatted.set("image", rawNull)
	}
	hit.set("_formatted", formatted.bytes())
	return nil
}

// avatarIndexes is AVATAR_INDEXES: the indexes whose hits carry a user (a users hit is the user).
func avatarIndex(uid string) bool {
	switch uid {
	case ModelsIndex, ArticlesIndex, BountiesIndex, CollectionsIndex, ComicsIndex, UsersIndex:
		return true
	}
	return false
}

// capHitAvatar is capHitAvatar: under a cap a hit's user (a users hit itself) loses `image` (it has no
// rating) and keeps `profilePicture` only when the hit's own picture is rated inside the cap; the
// highlight copy follows the hit's verdict.
func capHitAvatar(uid string, hit *object, cap int) error {
	holderOfHit := hit
	if uid != UsersIndex {
		holderOfHit = nil
		if u, ok := hit.get("user"); ok && isObject(u) {
			o, err := parseObject(u)
			if err != nil {
				return err
			}
			holderOfHit = o
		}
	}
	kept := false
	if holderOfHit != nil {
		if pic, ok := holderOfHit.get("profilePicture"); ok && isObject(pic) {
			p, err := parseObject(pic)
			if err != nil {
				return err
			}
			level, present := p.get("nsfwLevel")
			var err2 error
			if kept, err2 = ratingWithinCap(level, present, cap); err2 != nil {
				return err2
			}
		}
	}
	// capHolder: `{ ...holder, image: null, profilePicture: kept ? holder.profilePicture : null }`.
	capHolder := func(holder *object) {
		pic, hasPic := holder.get("profilePicture")
		holder.set("image", rawNull)
		switch {
		case !kept:
			holder.set("profilePicture", rawNull)
		case hasPic:
			holder.set("profilePicture", pic)
		default:
			// `profilePicture: undefined`: JSON.stringify writes no member.
		}
	}
	// capDoc: a users doc is the holder; any other doc with a `user` member gets that member capped
	// when it is an object, and is left alone when it has none.
	capDoc := func(doc *object) error {
		if uid == UsersIndex {
			capHolder(doc)
			return nil
		}
		u, ok := doc.get("user")
		if !ok || !isObject(u) {
			return nil
		}
		holder, err := parseObject(u)
		if err != nil {
			return err
		}
		capHolder(holder)
		doc.set("user", holder.bytes())
		return nil
	}
	formattedRaw, hasFormatted := hit.get("_formatted")
	if err := capDoc(hit); err != nil {
		return err
	}
	if hasFormatted && isObject(formattedRaw) {
		formatted, err := parseObject(formattedRaw)
		if err != nil {
			return err
		}
		if err := capDoc(formatted); err != nil {
			return err
		}
		hit.set("_formatted", formatted.bytes())
	}
	return nil
}

// shapeIndexHit is shapeIndexHits' rule for one hit of uid.
func shapeIndexHit(uid string, hit *object, v Viewer) error {
	switch uid {
	case ModelsIndex:
		return shapeModelHit(hit, v)
	case ComicsIndex:
		return shapeComicHit(hit, v.Cap)
	case BountiesIndex:
		return shapeBountyHit(hit, v.Cap)
	case CollectionsIndex:
		if v.Cap != 0 {
			return shapeCollectionHit(hit, v.Cap, false)
		}
		// The index keeps a src only for an SFW article cover, so a viewer on every SFW level may have it.
		level := v.CollectionImageLevel
		return shapeCollectionHit(hit, level, level != 0 && level|3 == level)
	}
	return nil
}

// ShapeHits is shapeHits: the hits of a result on uid as this viewer may receive them. present
// reports whether the result carries `hits`; the returned present is whether the shaped result does
// (an absent list stays absent, except that a capped one becomes []).
func ShapeHits(uid string, hits []byte, present bool, v Viewer) ([]byte, bool, error) {
	if !HitsNeedShaping(uid, v) {
		return hits, present, nil
	}
	capped := v.Cap != 0 || (uid == CollectionsIndex && v.CollectionImageLevel != 0)
	if !present || !isArray(hits) {
		if capped {
			return rawEmptyArray, true, nil
		}
		return hits, present, nil
	}
	elems, err := parseArray(hits)
	if err != nil {
		return nil, false, err
	}
	changed := false
	for i, e := range elems {
		// Every index that shapes reads its hits as objects (a primitive throws, or is spread into an
		// empty object): not reproduced.
		if !isObject(e) {
			return nil, false, errShape
		}
		hit, err := parseObject(e)
		if err != nil {
			return nil, false, err
		}
		if err := shapeIndexHit(uid, hit, v); err != nil {
			return nil, false, err
		}
		if v.Cap != 0 && avatarIndex(uid) {
			if err := capHitAvatar(uid, hit, v.Cap); err != nil {
				return nil, false, err
			}
		}
		elems[i] = hit.bytes()
		changed = true
	}
	if !changed {
		return hits, true, nil
	}
	return appendArray(make([]byte, 0, len(hits)), elems), true, nil
}
