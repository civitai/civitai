export type Copy = {
  icon: 'scan-eye' | 'lock' | 'hourglass' | 'triangle-alert';
  kicker: string;
  title: string;
  body: string;
  retry: boolean;
};

/** SvelteKit's message for an `error(status)` thrown without one. */
const defaultMessage = (status: number) => `Error: ${status}`;

/**
 * A 401/403 shows the route's own reason when it gave one. 5xx messages are SvelteKit's generic "Internal Error",
 * never the cause, so only the copy below is shown.
 */
export function copyFor(status: number, message?: string): Copy {
  const reason = message?.trim();
  if (status === 404)
    return {
      icon: 'scan-eye',
      kicker: 'Lost in the halls',
      title: 'No such chamber in the Order',
      body: 'The page you followed does not exist, or it has moved. Return to the hall and carry on judging.',
      retry: false,
    };
  if (status === 401 || status === 403)
    return {
      icon: 'lock',
      kicker: 'A sealed door',
      title: 'This door is not yours to open',
      body:
        reason && reason !== defaultMessage(status)
          ? reason
          : 'You do not have access to this page.',
      retry: false,
    };
  if (status === 429)
    return {
      icon: 'hourglass',
      kicker: 'Steady, knight',
      title: 'Too much, too fast',
      body: 'Give it a moment, then try again.',
      retry: true,
    };
  if (status >= 500)
    return {
      icon: 'triangle-alert',
      kicker: 'The Order stumbled',
      title: 'Something broke on our side',
      body: 'It is not something you did. Try again in a moment.',
      retry: true,
    };
  return {
    icon: 'triangle-alert',
    kicker: 'A misstep',
    title: 'That request went astray',
    body: 'The Order could not handle that request. Return to the hall and try again.',
    retry: false,
  };
}
