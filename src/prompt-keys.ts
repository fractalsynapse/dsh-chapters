/**
 * Identifiers shared by BOTH planes of the push transport (#194). One module, one spelling: the
 * server registers the projection under this key and the client reads `useProjection(key)` — two
 * literals in two planes would be exactly the drift #59 forbids. No node imports (the client
 * compiles this), no DOM (the server imports this).
 */
export const PROMPT_PROJECTION_KEY = 'chaptersPrompt'
