import { describe, it, expect } from 'vitest';
import { sanitizeSvg, svgDataUri, SvgError, SVG_LIMITS } from '../src/canvas-svg.js';

const wrap = (body: string, attrs = 'viewBox="0 0 24 24"') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const circle = '<circle cx="12" cy="12" r="10" fill="#f00"/>';

describe('sanitizeSvg: what it keeps', () => {
  it('keeps ordinary drawing, rewritten in one canonical form', () => {
    const out = sanitizeSvg(`<?xml version="1.0"?>\n<!-- made by hand -->\n${wrap(`<g transform="translate(1 1)">${circle}<path d="M1 1L5 5" stroke="currentColor"/></g>`)}`);
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g transform="translate(1 1)"><circle cx="12" cy="12" r="10" fill="#f00"/><path d="M1 1L5 5" stroke="currentColor"/></g></svg>',
    );
  });

  it('is idempotent', () => {
    const inputs = [
      wrap(`<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="5" height="5" fill="url(#g)" style="stroke: red; opacity:.5"/>`),
      wrap('<text x="1" y="10">a &lt; b &amp; "c"\n</text>'),
      wrap('<use href="#c"/><circle id="c" r="2"/>'),
      '<svg width="48" height="32"><rect width="1" height="1"/></svg>',
    ];
    for (const input of inputs) {
      const once = sanitizeSvg(input);
      expect(sanitizeSvg(once)).toBe(once);
    }
  });

  it('adds a viewBox from plain width and height, so it scales as an icon', () => {
    expect(sanitizeSvg('<svg width="48" height="32px"><rect width="1" height="1"/></svg>')).toContain('viewBox="0 0 48 32"');
  });

  it('keeps fragment references and turns xlink:href into href', () => {
    const out = sanitizeSvg(wrap('<defs><circle id="dot" r="2"/></defs><use xlink:href="#dot" x="4"/>', 'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 8 8"'));
    expect(out).toContain('<use href="#dot" x="4"/>');
    expect(out).not.toContain('xlink');
  });

  it('accepts CDATA and character references in text', () => {
    expect(sanitizeSvg(wrap('<text><![CDATA[a<b]]> &#65;&#x42;</text>'))).toContain('<text>a&lt;b AB</text>');
  });

  it('drops editor metadata and keeps the drawing', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="x" inkscape:version="1" viewBox="0 0 2 2"><sodipodi:namedview id="n"/><metadata><rdf:RDF/></metadata><rect width="1" height="1"/></svg>',
    );
    expect(out).toBe('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="1" height="1"/></svg>');
  });

  it('draws as a data URI image', () => {
    expect(svgDataUri('<svg/>')).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E');
  });
});

describe('sanitizeSvg: malicious input', () => {
  const removes = (input: string, ...gone: string[]) => {
    const out = sanitizeSvg(input).toLowerCase();
    for (const g of gone) expect(out).not.toContain(g.toLowerCase());
    return out;
  };

  it('removes scripts, with their content', () => {
    removes(wrap(`<script>alert(1)</script>${circle}`), 'script', 'alert');
    removes(wrap(`<script type="text/javascript"><![CDATA[alert(1)]]></script>${circle}`), 'script', 'alert');
    removes(wrap(`<svg:script>alert(1)</svg:script>${circle}`), 'script', 'alert');
  });

  it('removes event handlers', () => {
    removes(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="1" onclick="alert(2)" onmouseover="x()"/></svg>`, 'onload', 'onclick', 'onmouseover', 'alert');
  });

  it('removes foreignObject, with the HTML inside it', () => {
    removes(wrap(`<foreignObject><iframe src="javascript:alert(1)"></iframe><body onload="x()"/></foreignObject>${circle}`), 'foreignobject', 'iframe', 'javascript', 'onload');
  });

  it('removes external references', () => {
    const out = removes(
      wrap(
        `<image href="https://evil.example/x.png"/><use href="https://evil.example/s.svg#a"/><use xlink:href="data:image/svg+xml,&lt;svg/&gt;"/>` +
          `<a href="javascript:alert(1)"><rect width="1" height="1"/></a>` +
          `<rect width="2" height="2" fill="url(https://evil.example/p)" style="fill:url(http://evil.example/q);stroke:blue"/>` +
          `<rect width="3" height="3" filter="url( 'data:x' )" mask="url(#ok)"/>${circle}`,
      ),
      'evil.example',
      'javascript',
      'data:',
      '<image',
      '<a ',
    );
    expect(out).toContain('style="stroke:blue"');
    expect(out).toContain('mask="url(#ok)"');
  });

  it('removes styles, animation and links that could smuggle behaviour', () => {
    removes(
      wrap(`<style>@import url(https://evil.example/x.css); circle{fill:red}</style><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="href" values="javascript:alert(1)"/>${circle}`),
      '<style',
      '@import',
      '<set',
      '<animate',
      'javascript',
    );
  });

  it('refuses entity definitions and unknown entities (no entity bombs)', () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]><svg xmlns="http://www.w3.org/2000/svg"><text>&b;</text></svg>';
    expect(() => sanitizeSvg(bomb)).toThrow(SvgError);
    expect(() => sanitizeSvg(wrap('<text>&nbsp;</text>'))).toThrow(/entity/);
    expect(() => sanitizeSvg(wrap('<text>&#0;</text>'))).toThrow(/character reference/);
  });

  it('accepts a plain DOCTYPE and drops it', () => {
    expect(sanitizeSvg(`<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">${wrap(circle)}`)).not.toContain('DOCTYPE');
  });

  it('refuses malformed XML rather than guessing', () => {
    for (const bad of [
      wrap('<circle r=1/>'),
      wrap('<circle r="1">'),
      wrap('<g><circle r="1"/></rect></g>'),
      '<svg><circle r="1"/></svg><svg/>',
      wrap('<circle r="1" r="2"/>'),
      wrap('<circle r="1"x="2"/>'),
      wrap('<text>a & b</text>'),
      `${wrap(circle)} trailing`,
      wrap('<circle r="<"/>'),
    ]) {
      expect(() => sanitizeSvg(bad), bad).toThrow(SvgError);
    }
  });

  it('refuses things that are not an SVG', () => {
    expect(() => sanitizeSvg('<html><body/></html>')).toThrow(/top-level element must be <svg>/);
    expect(() => sanitizeSvg('')).toThrow(SvgError);
    expect(() => sanitizeSvg(42)).toThrow(SvgError);
    expect(() => sanitizeSvg(wrap('<script>alert(1)</script>'))).toThrow(/Nothing is left to draw/);
  });

  it('caps the size, the element count and the nesting', () => {
    expect(() => sanitizeSvg(wrap(`<!--${'x'.repeat(SVG_LIMITS.maxBytes)}-->${circle}`))).toThrow(/KB/);
    expect(() => sanitizeSvg(wrap('<g>'.repeat(SVG_LIMITS.maxDepth + 1) + circle + '</g>'.repeat(SVG_LIMITS.maxDepth + 1)))).toThrow(/deep/);
    expect(() => sanitizeSvg(wrap('<rect/>'.repeat(SVG_LIMITS.maxElements + 1)))).toThrow(/elements/);
  });

  it('stops <use> chains that multiply into a rendering bomb', () => {
    const out = sanitizeSvg(
      wrap(
        '<defs><g id="a"><circle r="1"/></g><g id="b"><use href="#a"/><use href="#a"/></g><g id="c"><use href="#b"/><use href="#b"/></g></defs><use href="#c"/><use href="#a"/>',
      ),
    );
    expect(out).not.toContain('href="#b"');
    expect(out).not.toContain('href="#c"');
    expect(out.match(/href="#a"/g)).toHaveLength(3);
  });

  it('drops control characters and backslash escapes in values', () => {
    removes(wrap('<rect width="1" height="1" fill="u\\72l(https://evil.example)"/><circle r="1" style="fill:\\75rl(x)"/>'), 'evil.example', '\\');
  });
});
