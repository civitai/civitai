// process-rewards and user.controller iterate this module's values and treat every
// one as a BuzzEvent, so only rewards belong here — import helpers from their file.
export { imagePostedToModelReward } from './passive/imagePostedToModel.reward';
export { encouragementReward } from './active/encouragement.reward';
export { firstDailyPostReward } from './active/firstDailyPost.reward';
export { appBlockReviewReward } from './active/appBlockReview.reward';
export { goodContentReward } from './passive/goodContent.reward';
export { collectedContentReward } from './passive/collectedContent.reward';
export { refereeCreatedReward } from './active/refereeCreated.reward';
export { userReferredReward } from './active/userReferred.reward';
export { reportAcceptedReward } from './passive/reportAccepted.reward';
export { firstDailyFollowReward } from './active/firstDailyFollow.reward';
export { dailyBoostReward } from './active/dailyBoost.reward';
export { generatorFeedbackReward } from './active/generatorFeedback.reward';
export { stickerPlacementAcceptedReward } from './active/stickerPlacementAccepted.reward';
// export { adWatchedReward } from './active/adWatched.reward';
