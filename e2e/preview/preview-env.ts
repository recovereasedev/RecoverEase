/**
 * Where the local Super Admin preview runs, and the Supabase address it is
 * built with.
 *
 * The address is on `.invalid`, a top-level domain reserved never to exist
 * (RFC 2606): nothing it names can be resolved, let alone reached. So even
 * if the stub failed to answer a request, the browser could not deliver it
 * to any real Supabase project - and the preview's own network guard aborts
 * it before it is tried.
 */
export const PREVIEW_PORT = 4174
export const PREVIEW_ORIGIN = `http://127.0.0.1:${PREVIEW_PORT}`
export const PREVIEW_SUPABASE_URL = 'https://supabase.preview.invalid'
/** Not a key: the stub never checks it, and nothing real would accept it. */
export const PREVIEW_PUBLISHABLE_KEY = 'preview-placeholder-not-a-key'
/** The preview's own build, kept apart from `dist`, which is what deploys. */
export const PREVIEW_OUT_DIR = '.preview-dist'

/**
 * Where the preview starts: a new Super Admin setting up an authenticator, a
 * later sign-in entering its code, or a session already verified.
 */
export type PreviewState = 'enrol' | 'verify' | 'console'
