import { execSync } from 'child_process';

export function executeGitCommand(command: string) {
  return execSync(command)
    .toString('utf8')
    .replace(/[\n\r\s]+$/, '');
}

export const GIT_BRANCH_NAME = executeGitCommand('git rev-parse --abbrev-ref HEAD');
