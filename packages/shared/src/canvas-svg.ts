/**
 * Custom SVG icons for canvases: a strict, allowlist sanitiser.
 *
 * An uploaded SVG is never stored or shown as it came. It is parsed by the
 * small, strict XML reader below, and a new document is written from what the
 * reader understood: only allowlisted elements and attributes survive, every
 * value is escaped again on the way out, and anything this reader does not
 * understand is refused rather than passed through. Malformed XML, a DOCTYPE
 * with an internal subset (entity definitions) and unknown entities are
 * refused outright.
 *
 * What is removed, element and everything inside it: scripts, styles,
 * foreignObject, images, links, animation, and every element not on the list,
 * including editor metadata (sodipodi:*, inkscape:*). Removed attributes:
 * event handlers (on*), anything not on the list, any `url(...)` that is not
 * a fragment (`url(#id)`), and `href` / `xlink:href` unless it names a
 * fragment (`#id`). A `<use>` may not point at something that itself holds a
 * `<use>`, so references cannot multiply into a rendering bomb.
 *
 * The result is also only ever drawn as an image (an `<img>` with a data URI),
 * never inserted into the page, so a browser would not run a script or fetch a
 * resource from it even if one got through. Sanitising is the first line, not
 * the only one.
 *
 * Pure, with no DOM, so the server (which is authoritative: every write runs
 * it) and the web app (for the owner's optimistic view) produce byte-identical
 * output. Running it on its own output changes nothing.
 */

export const SVG_LIMITS = {
  /** Largest SVG accepted, before and after sanitising, in UTF-8 bytes. */
  maxBytes: 64 * 1024,
  maxElements: 4000,
  maxDepth: 48,
  maxUses: 200,
} as const;

export class SvgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SvgError';
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Elements kept. Anything else is removed with everything inside it. */
const ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern', 'marker',
  'filter', 'feGaussianBlur', 'feOffset', 'feBlend', 'feFlood', 'feComposite', 'feMerge', 'feMergeNode',
  'feColorMatrix', 'feDropShadow', 'feMorphology',
]);

/** Elements that draw something. An SVG with none of them is refused. */
const DRAWING = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'use']);

/** Elements whose text content is kept. Everywhere else text is dropped. */
const TEXT_ELEMENTS = new Set(['title', 'desc', 'text', 'tspan']);

/** Attributes kept, on any kept element. */
const ATTRIBUTES = new Set([
  'id', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr',
  'width', 'height', 'points', 'pathLength', 'viewBox', 'preserveAspectRatio', 'transform', 'version',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'color',
  'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits', 'maskContentUnits',
  'patternUnits', 'patternContentUnits', 'patternTransform',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'stop-color', 'stop-opacity',
  'display', 'visibility', 'overflow', 'vector-effect', 'shape-rendering', 'paint-order',
  'marker-start', 'marker-mid', 'marker-end', 'markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
  'letter-spacing', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust',
  'filter', 'filterUnits', 'primitiveUnits', 'in', 'in2', 'result', 'stdDeviation', 'mode', 'operator',
  'k1', 'k2', 'k3', 'k4', 'flood-color', 'flood-opacity', 'values', 'type', 'radius',
  'mix-blend-mode', 'isolation', 'href', 'style',
]);

/** CSS properties kept inside a `style` attribute. */
const STYLE_PROPERTIES = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'opacity', 'color',
  'clip-path', 'clip-rule', 'mask', 'stop-color', 'stop-opacity', 'display', 'visibility',
  'vector-effect', 'shape-rendering', 'paint-order', 'marker-start', 'marker-mid', 'marker-end',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'dominant-baseline',
  'letter-spacing', 'filter', 'flood-color', 'flood-opacity', 'mix-blend-mode', 'isolation',
]);

const FRAGMENT = /^#[A-Za-z_][A-Za-z0-9_.:-]*$/;
const URL_FUNCTION = /url\s*\(/gi;
const FRAGMENT_URL = /^url\s*\(\s*(['"]?)#[A-Za-z_][A-Za-z0-9_.:-]*\1\s*\)/i;

interface Element {
  name: string;
  attributes: Array<[string, string]>;
  children: Array<Element | string>;
}

// ---------------------------------------------------------------------------
// Reading: a strict XML reader for the subset SVG files use
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(raw: string): string {
  return raw.replace(/&([^;\s&<]*);?/g, (match, name: string) => {
    if (!match.endsWith(';')) throw new SvgError('The SVG has a stray "&". Write it as &amp;.');
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      if (!/^#[xX][0-9a-fA-F]{1,6}$/.test(name) || !validCodePoint(code)) throw new SvgError(`The SVG has an invalid character reference &${name};.`);
      return String.fromCodePoint(code);
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      if (!/^#[0-9]{1,7}$/.test(name) || !validCodePoint(code)) throw new SvgError(`The SVG has an invalid character reference &${name};.`);
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[name];
    if (value === undefined) throw new SvgError(`The SVG uses the entity &${name};, which plain XML does not define.`);
    return value;
  });
}

function validCodePoint(code: number): boolean {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff;
}

function readDocument(source: string): Element {
  let i = 0;
  const n = source.length;
  const stack: Element[] = [];
  let root: Element | null = null;
  let elements = 0;

  const fail = (message: string): never => {
    throw new SvgError(message);
  };
  const startsAt = (text: string) => source.startsWith(text, i);
  const skipUntil = (end: string, what: string) => {
    const at = source.indexOf(end, i);
    if (at < 0) fail(`The SVG has an unfinished ${what}.`);
    i = at + end.length;
  };

  if (source.charCodeAt(0) === 0xfeff) i = 1;

  while (i < n) {
    if (source[i] !== '<') {
      const next = source.indexOf('<', i);
      const end = next < 0 ? n : next;
      const text = source.slice(i, end);
      i = end;
      const parent = stack[stack.length - 1];
      if (!parent) {
        if (text.trim() !== '') fail('The SVG has text outside its <svg> element.');
        continue;
      }
      parent.children.push(decodeEntities(text));
      continue;
    }
    if (startsAt('<!--')) {
      i += 4;
      skipUntil('-->', 'comment');
      continue;
    }
    if (startsAt('<?')) {
      i += 2;
      skipUntil('?>', 'processing instruction');
      continue;
    }
    if (startsAt('<![CDATA[')) {
      const parent = stack[stack.length - 1];
      if (!parent) fail('The SVG has character data outside its <svg> element.');
      const start = i + 9;
      const end = source.indexOf(']]>', start);
      if (end < 0) fail('The SVG has an unfinished CDATA section.');
      parent!.children.push(source.slice(start, end));
      i = end + 3;
      continue;
    }
    if (startsAt('<!DOCTYPE') || startsAt('<!doctype')) {
      if (root || stack.length > 0) fail('The SVG has a DOCTYPE in the wrong place.');
      const end = source.indexOf('>', i);
      if (end < 0) fail('The SVG has an unfinished DOCTYPE.');
      // An internal subset is where entities (and entity bombs) are defined.
      if (source.slice(i, end).includes('[')) fail('The SVG defines its own entities in its DOCTYPE. Kite does not accept that.');
      i = end + 1;
      continue;
    }
    if (startsAt('<!')) fail('The SVG has a markup declaration Kite does not accept.');
    if (startsAt('</')) {
      const end = source.indexOf('>', i);
      if (end < 0) fail('The SVG has an unfinished closing tag.');
      const name = source.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) fail(`The SVG closes <${name}> where it should close <${open?.name ?? 'nothing'}>.`);
      i = end + 1;
      continue;
    }

    // An opening tag.
    i += 1;
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_.:-]*/.exec(source.slice(i, i + 200));
    if (!nameMatch) fail('The SVG has a malformed tag.');
    const name = nameMatch![0];
    i += name.length;
    const element: Element = { name, attributes: [], children: [] };
    const seen = new Set<string>();
    for (;;) {
      const ws = /^\s*/.exec(source.slice(i, i + 1000))![0];
      i += ws.length;
      if (i >= n) fail(`The SVG has an unfinished <${name}> tag.`);
      if (source[i] === '>' || startsAt('/>')) break;
      if (ws.length === 0) fail(`The SVG has a malformed <${name}> tag.`);
      const attrMatch = /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*/.exec(source.slice(i, i + 300));
      if (!attrMatch) fail(`The SVG has a malformed attribute on <${name}>.`);
      const attrName = attrMatch![1]!;
      i += attrMatch![0].length;
      const quote = source[i];
      if (quote !== '"' && quote !== "'") fail(`The attribute ${attrName} on <${name}> must be quoted.`);
      const close = source.indexOf(quote!, i + 1);
      if (close < 0) fail(`The attribute ${attrName} on <${name}> is not closed.`);
      const rawValue = source.slice(i + 1, close);
      if (rawValue.includes('<')) fail(`The attribute ${attrName} on <${name}> holds a "<".`);
      if (seen.has(attrName)) fail(`The attribute ${attrName} appears twice on <${name}>.`);
      seen.add(attrName);
      element.attributes.push([attrName, decodeEntities(rawValue)]);
      i = close + 1;
    }
    const selfClosing = startsAt('/>');
    i += selfClosing ? 2 : 1;

    elements += 1;
    if (elements > SVG_LIMITS.maxElements) fail(`The SVG has more than ${SVG_LIMITS.maxElements} elements.`);
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else if (root) fail('The SVG has more than one top-level element.');
    else root = element;
    if (!selfClosing) {
      stack.push(element);
      if (stack.length > SVG_LIMITS.maxDepth) fail(`The SVG nests elements more than ${SVG_LIMITS.maxDepth} deep.`);
    }
  }
  if (stack.length > 0) fail(`The SVG never closes <${stack[stack.length - 1]!.name}>.`);
  if (!root) fail('That is not an SVG: there is no <svg> element.');
  return root!;
}

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

/** Every url(...) in a value names a fragment of this same file. */
function onlyFragmentUrls(value: string): boolean {
  URL_FUNCTION.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = URL_FUNCTION.exec(value)) !== null) {
    if (!FRAGMENT_URL.test(value.slice(match.index))) return false;
  }
  return true;
}

/** Characters no attribute or style value needs, and that only help an attack. */
function plainValue(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\\<>]/.test(value) && !/javascript:|expression\s*\(|@import/i.test(value);
}

function cleanStyle(value: string): string | null {
  const kept: string[] = [];
  for (const declaration of value.split(';')) {
    if (declaration.trim() === '') continue;
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const propertyValue = declaration.slice(colon + 1).trim();
    if (!STYLE_PROPERTIES.has(property) || propertyValue === '') continue;
    if (!plainValue(propertyValue) || !onlyFragmentUrls(propertyValue) || /[{}]/.test(propertyValue)) continue;
    kept.push(`${property}:${propertyValue}`);
  }
  return kept.length === 0 ? null : kept.join(';');
}

function cleanAttribute(element: string, name: string, value: string): [string, string] | null {
  const local = name === 'xlink:href' ? 'href' : name;
  if (!ATTRIBUTES.has(local)) return null;
  if (local === 'href') return FRAGMENT.test(value.trim()) ? ['href', value.trim()] : null;
  if (local === 'style') {
    const style = cleanStyle(value);
    return style === null ? null : ['style', style];
  }
  if (local === 'type' && element !== 'feColorMatrix') return null;
  if (!plainValue(value) || !onlyFragmentUrls(value)) return null;
  return [local, value];
}

function clean(root: Element): Element {
  if (root.name !== 'svg' && root.name !== 'svg:svg') throw new SvgError('That is not an SVG: the top-level element must be <svg>.');

  const walk = (element: Element): Element | null => {
    const name = element.name.startsWith('svg:') ? element.name.slice(4) : element.name;
    if (!ELEMENTS.has(name)) return null;
    const attributes: Array<[string, string]> = [];
    const taken = new Set<string>();
    for (const [rawName, value] of element.attributes) {
      const kept = cleanAttribute(name, rawName, value);
      if (!kept || taken.has(kept[0])) continue;
      taken.add(kept[0]);
      attributes.push(kept);
    }
    const children: Array<Element | string> = [];
    for (const child of element.children) {
      if (typeof child === 'string') {
        if (TEXT_ELEMENTS.has(name)) children.push(child);
        continue;
      }
      const kept = walk(child);
      if (kept) children.push(kept);
    }
    return { name, attributes, children };
  };
  const cleaned = walk(root)!;

  // A <use> may only point at something with no <use> in it.
  const holdsUse = new Set<string>();
  const marks = (element: Element): boolean => {
    let has = element.name === 'use';
    for (const child of element.children) if (typeof child !== 'string' && marks(child)) has = true;
    const id = element.attributes.find(([k]) => k === 'id')?.[1];
    if (has && id) holdsUse.add(id);
    return has;
  };
  marks(cleaned);
  let uses = 0;
  const prune = (element: Element): Element | null => {
    if (element.name === 'use') {
      const href = element.attributes.find(([k]) => k === 'href')?.[1];
      if (!href || holdsUse.has(href.slice(1))) return null;
      uses += 1;
      if (uses > SVG_LIMITS.maxUses) throw new SvgError(`The SVG has more than ${SVG_LIMITS.maxUses} <use> elements.`);
    }
    const children: Array<Element | string> = [];
    for (const child of element.children) {
      if (typeof child === 'string') children.push(child);
      else {
        const kept = prune(child);
        if (kept) children.push(kept);
      }
    }
    return { ...element, children };
  };
  const result = prune(cleaned)!;

  // Drawn as an image at icon size, it needs a viewBox to scale.
  const attr = (k: string) => result.attributes.find(([key]) => key === k)?.[1];
  if (!attr('viewBox')) {
    const width = Number.parseFloat(attr('width') ?? '');
    const height = Number.parseFloat(attr('height') ?? '');
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && /^[\d.]+(px)?$/.test((attr('width') ?? '').trim()) && /^[\d.]+(px)?$/.test((attr('height') ?? '').trim())) {
      result.attributes.push(['viewBox', `0 0 ${width} ${height}`]);
    }
  }
  return result;
}

function draws(element: Element): boolean {
  if (DRAWING.has(element.name)) return true;
  return element.children.some((child) => typeof child !== 'string' && draws(child));
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

const escapeText = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttribute = (text: string) => escapeText(text).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;');

function write(element: Element, isRoot: boolean): string {
  const attributes = element.attributes.filter(([k]) => !(isRoot && k === 'xmlns'));
  const head = `<${element.name}${isRoot ? ` xmlns="${SVG_NS}"` : ''}${attributes.map(([k, v]) => ` ${k}="${escapeAttribute(v)}"`).join('')}`;
  if (element.children.length === 0) return `${head}/>`;
  const body = element.children.map((child) => (typeof child === 'string' ? escapeText(child) : write(child, false))).join('');
  return `${head}>${body}</${element.name}>`;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The safe form of an SVG, or an SvgError saying why it cannot be used.
 * Deterministic and idempotent: sanitizeSvg(sanitizeSvg(x)) === sanitizeSvg(x).
 */
export function sanitizeSvg(input: unknown): string {
  if (typeof input !== 'string' || input.trim() === '') throw new SvgError('An SVG icon needs the SVG source as text.');
  const size = utf8Length(input);
  if (size > SVG_LIMITS.maxBytes) {
    throw new SvgError(`This SVG is ${Math.ceil(size / 1024)} KB. An SVG icon can be up to ${SVG_LIMITS.maxBytes / 1024} KB.`);
  }
  const cleaned = clean(readDocument(input));
  if (!draws(cleaned)) throw new SvgError('Nothing is left to draw in this SVG once unsafe parts are removed.');
  const output = write(cleaned, true);
  if (utf8Length(output) > SVG_LIMITS.maxBytes) {
    throw new SvgError(`This SVG is larger than ${SVG_LIMITS.maxBytes / 1024} KB.`);
  }
  return output;
}

/** How a sanitised SVG is drawn: an image, never inline markup. */
export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
