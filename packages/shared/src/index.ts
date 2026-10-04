/**
 * Types shared between the server, the CLI and the web app.
 * The HTTP API is the product contract; these types mirror it.
 */

/** The two content formats an artifact can hold. */
export const ARTIFACT_TYPES = ['markdown', 'html'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export function isArtifactType(value: unknown): value is ArtifactType {
  return typeof value === 'string' && (ARTIFACT_TYPES as readonly string[]).includes(value);
}

/** Maps a file extension to the artifact type it produces, or null if unsupported. */
export function artifactTypeForExtension(extension: string): ArtifactType | null {
  const normalised = extension.toLowerCase().replace(/^\./, '');
  if (normalised === 'md' || normalised === 'markdown') return 'markdown';
  if (normalised === 'html' || normalised === 'htm') return 'html';
  return null;
}

/**
 * Fenced-block languages drawn as diagrams instead of shown as code. The server
 * keeps their source intact; the app draws them in a sandboxed frame.
 */
export const DIAGRAM_LANGUAGES = ['mermaid', 'svg'] as const;
export type DiagramLanguage = (typeof DIAGRAM_LANGUAGES)[number];

export * from './api-types.js';
export * from './expiry.js';
