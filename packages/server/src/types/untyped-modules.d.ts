/** Types for the few dependencies that publish none. Only what Kite calls. */

declare module 'subset-font' {
  interface SubsetFontOptions {
    targetFormat?: 'sfnt' | 'truetype' | 'woff' | 'woff2';
    /** Pins an axis to one value, or narrows it. */
    variationAxes?: Record<string, number | { min: number; max: number; default?: number }>;
    preserveNameIds?: number[];
    noLayoutClosure?: boolean;
  }
  export default function subsetFont(font: Buffer | Uint8Array, text: string, options?: SubsetFontOptions): Promise<Buffer>;
}

declare module 'fontverter' {
  export function convert(font: Buffer | Uint8Array, toFormat: 'truetype' | 'sfnt' | 'woff' | 'woff2', fromFormat?: string): Promise<Buffer>;
  export function detectFormat(font: Buffer | Uint8Array): string;
}

declare module 'linebreak' {
  export default class LineBreaker {
    constructor(text: string);
    /** The next place a line may end: before `position` (a UTF-16 index). `required` after a hard break. */
    nextBreak(): { position: number; required: boolean } | null;
  }
}
