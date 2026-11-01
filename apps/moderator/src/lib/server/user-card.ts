import { canAccess } from './access';

// The card is User Lookup's header, email included, so it is exactly as visible as that page.
export const canSeeUserCard = (locals: App.Locals) => canAccess(locals.user, '/retool/user-lookup');
