/**
 * The version is set once, in the root package.json, and a vX.Y.Z tag is cut
 * from it. A version that is not plain semver would make a tag nobody can
 * order, or one siteio's tag deploys would never pick up.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KITE_VERSION } from '../src/version.js';

const root = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: unknown };

describe('the Kite version', () => {
  it('is plain semver, with no leading v and no pre-release tail', () => {
    expect(root.version).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  });

  it('falls back to "dev" where no build put a version in, rather than breaking', () => {
    // Unit tests run without the build step that fills it in.
    expect(KITE_VERSION).toBe('dev');
  });
});
