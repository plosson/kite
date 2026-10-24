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

/** One SVG element of a Lucide icon: its tag and attributes, drawn on a 24×24 grid. */
export type LucideShape = [string, Record<string, string | number>];

let shapes: Map<string, LucideShape[]> | null = null;

function lucideShapesByName(): Map<string, LucideShape[]> {
  if (!shapes) {
    const require = createRequire(import.meta.url);
    shapes = new Map(Object.entries(require('lucide-static/icon-nodes.json') as Record<string, LucideShape[]>));
  }
  return shapes;
}

function lucideNames(): Map<string, unknown> {
  return lucideShapesByName();
}

/** The shapes of a Lucide icon, or null when there is no such icon. */
export function lucideShapes(name: string): LucideShape[] | null {
  return lucideShapesByName().get(name) ?? null;
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
