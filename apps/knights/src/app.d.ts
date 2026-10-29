import type { SessionUser } from '@civitai/auth';

declare global {
  namespace App {
    interface Locals {
      user: SessionUser;
    }
  }
}

export {};
