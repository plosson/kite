/**
 * Lines of text, broken and placed the way the web app's stylesheet breaks
 * and places them, so a card's text wraps at the same words in an image.
 *
 * - `pre-wrap`: a text card. Spaces and newlines are kept, a line may end
 *   wherever Unicode's line-breaking rules allow (UAX #14), spaces at the end
 *   of a line hang past it, and a word too long for a line on its own is broken
 *   between letters (`overflow-wrap: break-word`).
 * - `normal`: runs of spaces collapse to one; otherwise the same.
 * - `break-all`: a URL. It may break between any two letters.
 * - `ellipsis`: one line, cut with … when it does not fit (`truncate`).
 *
 * A line's height is the CSS line height. Its baseline sits where CSS puts it:
 * half the leading above the font's ascent, from the line's top.
 */

import LineBreaker from 'linebreak';
import type { FontEngine, FontMetrics, FontUse, PlacedGlyph, Typeface } from './fonts.js';

export type WrapMode = 'pre-wrap' | 'normal' | 'break-all' | 'ellipsis';

export interface TextStyle {
  typeface: Typeface;
  weight: number;
  size: number;
  /** In pixels. */
  lineHeight: number;
  letterSpacing: number;
  italic?: boolean;
  underline?: boolean;
  uppercase?: boolean;
  /** A colour for SVG, and its opacity. */
  fill: string;
  fillOpacity?: number;
}

export interface TextLine {
  text: string;
  /** Without the spaces hanging at its end. */
  width: number;
  glyphs: PlacedGlyph[];
}

export interface TextBlock {
  style: TextStyle;
  lines: TextLine[];
  /** The widest line. */
  width: number;
  height: number;
  metrics: FontMetrics;
  /** From a line's top to its baseline. */
  baseline: number;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function splitGraphemes(text: string): string[] {
  return Array.from(graphemes.segment(text), (s) => s.segment);
}

/** Where a line may end in a paragraph: UTF-16 positions, the last being its end. */
function breakPositions(text: string): number[] {
  const breaker = new LineBreaker(text);
  const positions: number[] = [];
  let found;
  while ((found = breaker.nextBreak())) positions.push(found.position);
  if (positions[positions.length - 1] !== text.length) positions.push(text.length);
  return positions;
}

/** `use`, when given, collects the characters set, for an SVG's embedded fonts. */
export function layoutText(engine: FontEngine, raw: string, style: TextStyle, maxWidth: number, mode: WrapMode, use?: FontUse): TextBlock {
  const text = style.uppercase ? raw.toUpperCase() : raw;
  const measure = (s: string) => engine.shape(s, style.typeface, style.weight, style.size, style.letterSpacing).width;
  const visible = (s: string) => measure(s.replace(/[ \t]+$/, ''));
  const available = Math.max(0, maxWidth);
  const lineTexts: string[] = [];

  if (mode === 'ellipsis') {
    const one = text.replace(/\s+/g, ' ');
    if (measure(one) <= available) lineTexts.push(one);
    else {
      const parts = splitGraphemes(one);
      let cut = parts.length;
      while (cut > 0 && measure(parts.slice(0, cut).join('') + '…') > available) cut--;
      lineTexts.push(parts.slice(0, cut).join('') + '…');
    }
  } else {
    const paragraphs =
      mode === 'normal' ? [text.replace(/\s+/g, ' ').trim()] : text.replace(/\r\n?/g, '\n').split('\n');
    for (const paragraph of paragraphs) {
      if (paragraph === '') {
        lineTexts.push('');
        continue;
      }
      // Pieces a line may end after: words with their trailing spaces, or single letters for a URL.
      let pieces: string[];
      if (mode === 'break-all') pieces = splitGraphemes(paragraph);
      else {
        pieces = [];
        let from = 0;
        for (const at of breakPositions(paragraph)) {
          if (at > from) pieces.push(paragraph.slice(from, at));
          from = at;
        }
      }
      let line = '';
      // Starts a line with a piece; a word wider than the line on its own is broken between letters.
      const startWith = (piece: string): string => {
        if (mode === 'break-all' || visible(piece) <= available) return piece;
        let current = '';
        for (const letter of splitGraphemes(piece)) {
          if (current !== '' && visible(current + letter) > available) {
            lineTexts.push(current);
            current = '';
          }
          current += letter;
        }
        return current;
      };
      for (const piece of pieces) {
        if (line === '') line = startWith(piece);
        else if (visible(line + piece) <= available) line += piece;
        else {
          lineTexts.push(line);
          line = startWith(piece);
        }
      }
      lineTexts.push(line);
    }
  }

  const lines = lineTexts.map((t) => {
    const trimmed = t.replace(/[ \t]+$/, '');
    const shaped = engine.shape(trimmed, style.typeface, style.weight, style.size, style.letterSpacing, use);
    return { text: trimmed, width: shaped.width, glyphs: shaped.glyphs };
  });
  const metrics = engine.metrics(style.typeface, style.weight, style.size);
  const halfLeading = Math.floor((style.lineHeight - (metrics.ascent + metrics.descent)) / 2);
  return {
    style,
    lines,
    width: lines.reduce((w, l) => Math.max(w, l.width), 0),
    height: lines.length * style.lineHeight,
    metrics,
    baseline: halfLeading + metrics.ascent,
  };
}
