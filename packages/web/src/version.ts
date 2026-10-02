/**
 * Which Kite this is, as set in the root package.json and tagged vX.Y.Z.
 * Replaced with the real value when the bundle is built; "dev" only where
 * nothing built it, so a missing version never breaks the page.
 */

declare const __KITE_VERSION__: string | undefined;

export const KITE_VERSION: string = typeof __KITE_VERSION__ === 'string' ? __KITE_VERSION__ : 'dev';
