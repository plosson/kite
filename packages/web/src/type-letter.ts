import type { ArtifactType } from '@open-artifact/shared';

/** The one-letter badge next to a document in lists. Exhaustive on purpose. */
export function typeLetter(type: ArtifactType): string {
  switch (type) {
    case 'markdown':
      return 'M';
    case 'html':
      return 'H';
    case 'canvas':
      return 'C';
    default: {
      const unknown: never = type;
      return String(unknown).slice(0, 1).toUpperCase();
    }
  }
}
