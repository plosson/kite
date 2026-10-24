/**
 * The canvas typefaces on the server: the same variable fonts the web app
 * serves (the @fontsource-variable packages), shaped with HarfBuzz.
 *
 * One engine does three things with them, so the text an image shows is laid
 * out once and drawn the same way in both formats:
 *
 * - measures text, for line breaking and alignment;
 * - gives glyph outlines, which is how text is drawn in a PNG (the rasteriser
 *   then needs no fonts of its own, and cannot pick a different one);
 * - subsets the faces a drawing used, pinned to the weights it used, for the
 *   @font-face rules embedded in an SVG.
 *
 * Each typeface ships split by script (latin, latin-ext, cyrillic…), exactly as
 * the browser downloads it. A character is drawn in the first part of the
 * named typeface that covers it, then in Inter's, which is where Kite's own
 * sans stack goes too. A character no part covers (an emoji, Chinese) is drawn
 * as the font's missing-glyph box; the app would show the reader's system font.
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CanvasFont } from '@open-artifact/shared';
import type * as Harfbuzz from 'harfbuzzjs';

type Hb = typeof Harfbuzz;
type HbFont = InstanceType<Hb['Font']>;
type HbFace = InstanceType<Hb['Face']>;

export type Typeface = 'inter' | 'grotesk' | 'serif' | 'mono' | 'hand';

const TYPEFACES: Record<Typeface, { pkg: string; prefix: string; family: string }> = {
  inter: { pkg: '@fontsource-variable/inter', prefix: 'inter', family: 'Inter' },
  grotesk: { pkg: '@fontsource-variable/space-grotesk', prefix: 'space-grotesk', family: 'Space Grotesk' },
  serif: { pkg: '@fontsource-variable/source-serif-4', prefix: 'source-serif-4', family: 'Source Serif 4' },
  mono: { pkg: '@fontsource-variable/jetbrains-mono', prefix: 'jetbrains-mono', family: 'JetBrains Mono' },
  hand: { pkg: '@fontsource-variable/caveat', prefix: 'caveat', family: 'Caveat' },
};

/**
 * The typeface a canvas font is drawn in. `sans` is the reader's own system
 * font in the app; an image has no reader, so it is Inter, which Kite's sans
 * stack names too.
 */
export const TYPEFACE_OF: Record<CanvasFont, Typeface> = {
  sans: 'inter',
  inter: 'inter',
  grotesk: 'grotesk',
  serif: 'serif',
  mono: 'mono',
  hand: 'hand',
};

/** The family an embedded face is declared as in an SVG, and what follows it. */
export function svgFamily(typeface: Typeface): string {
  const generic = typeface === 'serif' ? 'serif' : typeface === 'mono' ? 'monospace' : typeface === 'hand' ? 'cursive' : 'sans-serif';
  return `'Kite ${TYPEFACES[typeface].family}', '${TYPEFACES[typeface].family}', ${generic}`;
}

/** One script's part of a typeface: the file, and the characters it is for. */
interface FacePart {
  key: string;
  typeface: Typeface;
  path: string;
  ranges: Array<[number, number]>;
  unicodeRange: string;
}

interface LoadedPart {
  part: FacePart;
  woff2: Buffer;
  face: HbFace;
  upem: number;
  wght: { min: number; max: number };
  fonts: Map<number, HbFont>;
}

/** A glyph placed on a line, in pixels from the line's start on its baseline. */
export interface PlacedGlyph {
  part: string;
  weight: number;
  id: number;
  x: number;
  y: number;
  size: number;
}

export interface ShapedText {
  width: number;
  glyphs: PlacedGlyph[];
}

export interface FontMetrics {
  /** Rounded to whole pixels, as browsers lay out a line with them. */
  ascent: number;
  descent: number;
  underlineOffset: number;
  underlineThickness: number;
}

/** A path command, in font units. */
interface GlyphCommand {
  type: string;
  values: number[];
}

function parseRanges(spec: string): Array<[number, number]> {
  return spec.split(',').map((piece) => {
    const [from, to] = piece.trim().replace(/^U\+/i, '').split('-');
    const start = parseInt(from!, 16);
    return [start, to === undefined ? start : parseInt(to, 16)] as [number, number];
  });
}

let partsByTypeface: Map<Typeface, FacePart[]> | null = null;

function faceParts(): Map<Typeface, FacePart[]> {
  if (partsByTypeface) return partsByTypeface;
  const require = createRequire(import.meta.url);
  const found = new Map<Typeface, FacePart[]>();
  for (const [typeface, info] of Object.entries(TYPEFACES) as Array<[Typeface, (typeof TYPEFACES)[Typeface]]>) {
    const root = dirname(require.resolve(`${info.pkg}/package.json`));
    const unicode = JSON.parse(readFileSync(join(root, 'unicode.json'), 'utf8')) as Record<string, string>;
    const parts: FacePart[] = [];
    for (const [subset, spec] of Object.entries(unicode)) {
      const path = join(root, 'files', `${info.prefix}-${subset}-wght-normal.woff2`);
      if (!existsSync(path)) continue;
      parts.push({ key: `${typeface}/${subset}`, typeface, path, ranges: parseRanges(spec), unicodeRange: spec });
    }
    // The browser tries a family's faces last-declared first; fontsource
    // declares them so the narrow script parts win over the broad latin one.
    found.set(typeface, parts.reverse());
  }
  partsByTypeface = found;
  return found;
}

function covers(part: FacePart, codePoint: number): boolean {
  return part.ranges.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/**
 * Fonts loaded once per process and kept: a dozen files, a few hundred
 * kilobytes, and every image after the first one needs them again.
 */
export class FontEngine {
  private readonly loaded = new Map<string, LoadedPart>();
  private readonly loading = new Map<string, Promise<LoadedPart>>();
  private readonly glyphCache = new Map<string, GlyphCommand[]>();
  private readonly buffer: InstanceType<Hb['Buffer']>;

  private constructor(private readonly hb: Hb) {
    this.buffer = new hb.Buffer();
  }

  static async create(): Promise<FontEngine> {
    const hb = await import('harfbuzzjs');
    return new FontEngine(hb);
  }

  /** The part that draws a character: the typeface's own, then Inter's, then the typeface's main part. */
  private partFor(typeface: Typeface, codePoint: number): FacePart {
    const own = faceParts().get(typeface)!;
    const hit = own.find((p) => covers(p, codePoint));
    if (hit) return hit;
    if (typeface !== 'inter') {
      const inter = faceParts().get('inter')!.find((p) => covers(p, codePoint));
      if (inter) return inter;
    }
    return this.primaryPart(typeface);
  }

  /** The part with the space character: CSS takes a line's height and baseline from it. */
  private primaryPart(typeface: Typeface): FacePart {
    return faceParts().get(typeface)!.find((p) => covers(p, 0x20))!;
  }

  /** Loads every part the given texts need. Everything after this is synchronous. */
  async prepare(requests: Iterable<{ typeface: Typeface; text: string }>): Promise<void> {
    const wanted = new Map<string, FacePart>();
    for (const { typeface, text } of requests) {
      const primary = this.primaryPart(typeface);
      wanted.set(primary.key, primary);
      for (const char of text) {
        const part = this.partFor(typeface, char.codePointAt(0)!);
        wanted.set(part.key, part);
      }
    }
    for (const part of wanted.values()) await this.load(part);
  }

  /** Loads a part once, however many drawings ask for it at the same time. */
  private load(part: FacePart): Promise<LoadedPart> {
    let loading = this.loading.get(part.key);
    if (!loading) {
      loading = this.read(part);
      this.loading.set(part.key, loading);
      loading.then(
        (loaded) => this.loaded.set(part.key, loaded),
        () => this.loading.delete(part.key),
      );
    }
    return loading;
  }

  private async read(part: FacePart): Promise<LoadedPart> {
    const { convert } = await import('fontverter');
    const woff2 = readFileSync(part.path);
    const ttf = await convert(woff2, 'truetype');
    const face = new this.hb.Face(new this.hb.Blob(new Uint8Array(ttf)));
    const axis = face.getAxisInfos().wght;
    return {
      part,
      woff2,
      face,
      upem: face.upem,
      wght: axis ? { min: axis.min, max: axis.max } : { min: 400, max: 400 },
      fonts: new Map(),
    };
  }

  private loadedPart(part: FacePart): LoadedPart {
    const loaded = this.loaded.get(part.key);
    if (!loaded) throw new Error(`font part ${part.key} was not prepared`);
    return loaded;
  }

  /** The weight a variable face is drawn at: the one asked for, within what the face has. */
  private clampWeight(loaded: LoadedPart, weight: number): number {
    return Math.min(loaded.wght.max, Math.max(loaded.wght.min, weight));
  }

  private font(loaded: LoadedPart, weight: number): HbFont {
    const w = this.clampWeight(loaded, weight);
    let font = loaded.fonts.get(w);
    if (!font) {
      font = new this.hb.Font(loaded.face);
      font.setVariations([new this.hb.Variation('wght', w)]);
      loaded.fonts.set(w, font);
    }
    return font;
  }

  metrics(typeface: Typeface, weight: number, size: number): FontMetrics {
    const loaded = this.loadedPart(this.primaryPart(typeface));
    const font = this.font(loaded, weight);
    const extents = font.hExtents();
    const scale = size / loaded.upem;
    const offset = font.getMetricPosition(this.hb.MetricsTag.UNDERLINE_OFFSET);
    const thickness = font.getMetricPosition(this.hb.MetricsTag.UNDERLINE_SIZE);
    return {
      ascent: Math.round(extents.ascender * scale),
      descent: Math.round(-extents.descender * scale),
      // Below the baseline, as a positive distance.
      underlineOffset: offset === undefined ? size / 12 : -offset * scale,
      underlineThickness: Math.max(1, thickness === undefined ? size / 14 : thickness * scale),
    };
  }

  /**
   * Shapes one line. `letterSpacing` goes after every character, as CSS puts
   * it. A tab moves to the next stop eight spaces apart, as `tab-size: 8` does.
   */
  shape(text: string, typeface: Typeface, weight: number, size: number, letterSpacing = 0, use?: FontUse): ShapedText {
    const glyphs: PlacedGlyph[] = [];
    let x = 0;
    let tabStop = 0;
    const pieces = text.split('\t');
    for (let p = 0; p < pieces.length; p++) {
      if (p > 0) {
        if (!tabStop) tabStop = this.shapeRuns(' ', typeface, weight, size, letterSpacing, [], 0) * 8;
        x = (Math.floor(x / tabStop + 1e-6) + 1) * tabStop;
      }
      x = this.shapeRuns(pieces[p]!, typeface, weight, size, letterSpacing, glyphs, x, use);
    }
    return { width: x, glyphs };
  }

  /** Shapes text split into runs by the part that draws each character. Returns where it ends. */
  private shapeRuns(
    text: string,
    typeface: Typeface,
    weight: number,
    size: number,
    letterSpacing: number,
    out: PlacedGlyph[],
    start: number,
    use?: FontUse,
  ): number {
    let x = start;
    let run = '';
    let runPart: FacePart | null = null;
    const flush = () => {
      if (!run || !runPart) return;
      x = this.shapeRun(run, runPart, weight, size, letterSpacing, out, x, use);
      run = '';
    };
    for (const char of text) {
      const part = this.partFor(typeface, char.codePointAt(0)!);
      // A combining mark stays with the letter before it.
      if (runPart && part !== runPart && !/\p{M}/u.test(char)) flush();
      if (!run) runPart = part;
      run += char;
    }
    flush();
    return x;
  }

  private shapeRun(
    text: string,
    part: FacePart,
    weight: number,
    size: number,
    letterSpacing: number,
    out: PlacedGlyph[],
    start: number,
    use?: FontUse,
  ): number {
    const loaded = this.loadedPart(part);
    const font = this.font(loaded, weight);
    const scale = size / loaded.upem;
    const buffer = this.buffer;
    buffer.reset();
    buffer.addText(text);
    buffer.guessSegmentProperties();
    this.hb.shape(font, buffer);
    const infos = buffer.getGlyphInfos();
    const positions = buffer.getGlyphPositions();
    let x = start;
    const w = this.clampWeight(loaded, weight);
    for (let i = 0; i < infos.length; i++) {
      const info = infos[i]!;
      const pos = positions[i]!;
      out.push({ part: part.key, weight: w, id: info.codepoint, x: x + pos.xOffset * scale, y: -pos.yOffset * scale, size });
      x += pos.xAdvance * scale;
      const next = infos[i + 1];
      if (!next || next.cluster !== info.cluster) x += letterSpacing;
    }
    use?.add(part.key, w, text);
    return x;
  }

  /** How many of a part's font units make an em. */
  unitsPerEm(part: string): number {
    return this.loaded.get(part)!.upem;
  }

  /**
   * A glyph's outline as SVG path data in its font's units, y up, with `skew`
   * slanting it as a synthetic italic; and how many of those units make an em.
   */
  glyphOutline(glyph: PlacedGlyph, skew = 0): string {
    const cacheKey = `${glyph.part}@${glyph.weight}#${glyph.id}`;
    const loaded = this.loaded.get(glyph.part)!;
    let commands = this.glyphCache.get(cacheKey);
    if (!commands) {
      commands = this.font(loaded, glyph.weight).glyphToJson(glyph.id);
      this.glyphCache.set(cacheKey, commands);
    }
    let d = '';
    for (const command of commands) {
      d += command.type;
      for (let i = 0; i < command.values.length; i += 2) {
        const fy = command.values[i + 1]!;
        d += `${i ? ' ' : ''}${num(command.values[i]! + skew * fy)} ${num(fy)}`;
      }
    }
    return d;
  }

  /**
   * @font-face rules for what one drawing set as text, each part subset to the
   * characters used and pinned to the weight used.
   */
  async fontFaces(use: FontUse): Promise<string> {
    const { default: subsetFont } = await import('subset-font');
    const rules: string[] = [];
    for (const [key, used] of [...use.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const [partKey, weightText] = key.split('@') as [string, string];
      const loaded = this.loaded.get(partKey)!;
      const weight = Number(weightText);
      const chars = [...used].join('');
      const axes = loaded.wght.min === loaded.wght.max ? undefined : { wght: weight };
      const woff2 = await subsetFont(loaded.woff2, chars, { targetFormat: 'woff2', ...(axes ? { variationAxes: axes } : {}) });
      const family = TYPEFACES[loaded.part.typeface].family;
      rules.push(
        `@font-face{font-family:'Kite ${family}';font-weight:${weight};font-style:normal;` +
          `unicode-range:${loaded.part.unicodeRange};src:url(data:font/woff2;base64,${woff2.toString('base64')}) format('woff2')}`,
      );
    }
    return rules.join('');
  }
}

/** The characters one drawing set as text, per font part and weight, for subsetting its fonts. */
export class FontUse {
  private readonly used = new Map<string, Set<string>>();

  add(part: string, weight: number, text: string): void {
    const key = `${part}@${weight}`;
    let chars = this.used.get(key);
    if (!chars) this.used.set(key, (chars = new Set()));
    for (const char of text) chars.add(char);
  }

  entries(): IterableIterator<[string, Set<string>]> {
    return this.used.entries();
  }
}

/** A number for SVG: at most two decimals, no trailing zeros. */
export function num(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

let shared: Promise<FontEngine> | null = null;

/** The process's engine, made on first use. */
export function fontEngine(): Promise<FontEngine> {
  shared ??= FontEngine.create();
  return shared;
}
