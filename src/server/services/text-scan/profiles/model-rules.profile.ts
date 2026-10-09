import { registerTextScanProfile } from '~/server/services/text-scan/profiles';
import { loadModelScanSubjects } from '~/server/services/text-scan/profiles/model.profile';

// Rules only matter once a model is public: a Draft or an unpublished model loads as missing, so it
// is never submitted and a verdict arriving after it left public is dropped as "entity gone".
registerTextScanProfile({
  entityType: 'ModelRules',
  labels: ['modelRules'],
  load: (ids) => loadModelScanSubjects(ids, { publicOnly: true }),
});
