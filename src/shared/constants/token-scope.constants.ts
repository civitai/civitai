// Re-export shim: the token-scope constants moved to @civitai/auth so the hub (OAuth consent + scope
// validation) and the main app share ONE definition (forking the bitmask/labels would be a latent
// security/correctness bug). Existing call sites import from '~/shared/constants/token-scope.constants'
// unchanged. See docs/auth/oauth-provider-implementation-checklist.md §A.
export * from '@civitai/auth/token-scope';
