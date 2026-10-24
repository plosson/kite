/**
 * Icons on canvas nodes: Lucide's, drawn from its icon data, and a canvas's own
 * SVGs, drawn as images.
 *
 * Lucide's 1,900 icons are one JSON file of shapes that Vite copies into the
 * build as it is. It is fetched the first time a canvas with a Lucide icon is
 * shown, or the icon picker is opened, and never by anybody else. The shapes
 * are trusted (they ship with the app) and become React elements, so they take
 * the node's colour.
 *
 * A custom SVG came from somebody, so it is never put in the page as markup:
 * it was sanitised by the server when it was stored, and is shown as an <img>
 * of a data: URI, where a browser runs no script and loads nothing else.
 */
import { createElement, useEffect, useState } from 'react';
import { assetId, lucideName, svgDataUri, type CanvasAsset, type CanvasDocument, type CanvasIcon } from '@open-artifact/shared';
import iconNodesUrl from 'lucide-static/icon-nodes.json?url';
import tagsUrl from 'lucide-static/tags.json?url';
import { paint } from './look.js';

/** One icon: its shapes, each an element name and its attributes. */
export type LucideShapes = Array<[string, Record<string, string>]>;
export type LucideSet = Record<string, LucideShapes>;

let shapes: Promise<LucideSet> | null = null;
let tags: Promise<Record<string, string[]>> | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url}: ${response.status}`);
  return (await response.json()) as T;
}

export function loadLucide(): Promise<LucideSet> {
  shapes ??= fetchJson<LucideSet>(iconNodesUrl).catch((error: unknown) => {
    // A failed download is tried again next time rather than remembered.
    shapes = null;
    throw error;
  });
  return shapes;
}

/** Lucide's search words for each icon, for the picker. */
export function loadLucideTags(): Promise<Record<string, string[]>> {
  tags ??= fetchJson<Record<string, string[]>>(tagsUrl).catch((error: unknown) => {
    tags = null;
    throw error;
  });
  return tags;
}

/** Whether a canvas has any Lucide icon, so needs the icon data. */
export function usesLucide(doc: CanvasDocument | null): boolean {
  return !!doc?.nodes.some((n) => n.kite?.icon && lucideName(n.kite.icon) !== null);
}

/** The Lucide shapes once loaded, when `wanted`; null until then. */
export function useLucide(wanted: boolean): LucideSet | null {
  const [set, setSet] = useState<LucideSet | null>(null);
  useEffect(() => {
    if (!wanted || set) return;
    let live = true;
    loadLucide()
      .then((loaded) => live && setSet(loaded))
      .catch(() => {
        // Icons are left out; the node itself still draws.
      });
    return () => {
      live = false;
    };
  }, [wanted, set]);
  return set;
}

export function LucideGlyph({ shapes, size, colour, label }: { shapes: LucideShapes; size: number; colour: string; label?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={colour}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {shapes.map(([tag, attributes], index) => createElement(tag, { ...attributes, key: index }))}
    </svg>
  );
}

/** The default size of an icon beside text, and above it. */
export const ICON_SIZE = { left: 20, top: 32 } as const;

/** A node's icon, sized and coloured, or nothing while Lucide's data is on its way. */
export function NodeIcon({
  icon,
  assets,
  lucide,
  ink,
}: {
  icon: CanvasIcon;
  assets: Record<string, CanvasAsset> | undefined;
  lucide: LucideSet | null;
  ink: string;
}) {
  const size = icon.size ?? ICON_SIZE[icon.position ?? 'left'];
  const name = lucideName(icon);
  if (name !== null) {
    const found = lucide?.[name];
    return (
      <span className="kite-node-icon" style={{ width: size, height: size }} data-icon={icon.name}>
        {found && <LucideGlyph shapes={found} size={size} colour={icon.color ? paint(icon.color) : ink} />}
      </span>
    );
  }
  const asset = assets?.[assetId(icon) ?? ''];
  if (!asset) return null;
  return (
    <span className="kite-node-icon" style={{ width: size, height: size }} data-icon={icon.name}>
      <img src={svgDataUri(asset.svg)} width={size} height={size} alt={asset.name ?? ''} draggable={false} />
    </span>
  );
}
