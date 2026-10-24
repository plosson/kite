/**
 * Lucide icon names a canvas may use: exactly the icons the web app bundles.
 *
 * The shared canvas code checks an icon name's shape; only the server knows
 * the list, read once from the same lucide-static package the web app draws
 * from, so a canvas can never name an icon the app cannot draw.
 */

import { createRequire } from 'node:module';
import { lucideName, type CanvasDocument } from '@open-artifact/shared';
import { ApiError } from '../errors.js';

let names: Set<string> | null = null;

function lucideNames(): Set<string> {
  if (!names) {
    const require = createRequire(import.meta.url);
    names = new Set(Object.keys(require('lucide-static/icon-nodes.json') as Record<string, unknown>));
  }
  return names;
}

export function isLucideIcon(name: string): boolean {
  return lucideNames().has(name);
}

/** Refuses a canvas that names a Lucide icon that does not exist. */
export function requireKnownIcons(doc: CanvasDocument): void {
  for (const node of doc.nodes) {
    const icon = node.kite?.icon;
    const name = icon ? lucideName(icon) : null;
    if (name !== null && !isLucideIcon(name)) {
      throw new ApiError(
        'validation_failed',
        `node "${node.id}": there is no Lucide icon "${name}". Icon names are the ones listed on lucide.dev, like "server" or "database".`,
      );
    }
  }
}
