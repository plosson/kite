/**
 * Draws one diagram from a Markdown kite, inside a sandboxed frame.
 *
 * The page around it sends the diagram's source by message; this draws it and
 * answers with its height, or with an error so the page can show the source
 * instead. The frame runs at an opaque origin with no network and no access to
 * the reader's session (see diagramFramePolicy on the server), so a hostile
 * diagram can at worst draw something ugly inside its own box.
 */

import DOMPurify from 'dompurify';
import { DIAGRAM_MESSAGE, type DiagramRequest, type DiagramReplyBody, isDiagramRequest } from './diagram-protocol.js';

/** Longest source accepted, and most edges in a Mermaid graph: beyond these the frame gives up rather than hang. */
const MAX_SOURCE = 50_000;
const MAX_EDGES = 500;

const target = document.getElementById('diagram') as HTMLDivElement;

function reply(message: DiagramReplyBody): void {
  // The parent's origin is not known from in here: the frame is opaque, and so
  // is anything it could read. The reply carries only a height or an error.
  window.parent.postMessage({ type: DIAGRAM_MESSAGE, ...message }, '*');
}

function reportSize(): void {
  reply({ kind: 'size', height: Math.ceil(document.documentElement.scrollHeight) });
}

/** One SVG, with nothing in it that runs, links away or embeds a document. */
export function cleanSvg(source: string): string | null {
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['a', 'foreignObject', 'script', 'iframe', 'image', 'use'],
    FORBID_ATTR: ['href', 'xlink:href'],
  });
  const holder = document.createElement('div');
  holder.innerHTML = clean;
  const svg = holder.querySelector('svg');
  return svg ? svg.outerHTML : null;
}

async function drawMermaid(source: string, dark: boolean): Promise<string> {
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    maxTextSize: MAX_SOURCE,
    maxEdges: MAX_EDGES,
    flowchart: { htmlLabels: false },
    // A diagram may not reconfigure these from inside itself (%%{init}%%).
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'themeCSS', 'themeVariables', 'fontFamily', 'htmlLabels'],
  });
  const { svg } = await mermaid.render('kite-diagram', source);
  return svg;
}

async function draw(request: DiagramRequest): Promise<void> {
  if (request.source.length > MAX_SOURCE) throw new Error('This diagram is too long to draw.');
  const svg = request.language === 'mermaid' ? await drawMermaid(request.source, request.dark) : cleanSvg(request.source);
  if (!svg) throw new Error('There is no SVG in this block.');
  target.innerHTML = svg;
  reportSize();
  new ResizeObserver(reportSize).observe(document.body);
}

// Opened on its own, outside a frame, there is nobody to draw for.
if (window.parent !== window) {
  window.addEventListener('message', (event) => {
    // Only the page that framed this may ask, and only once.
    if (event.source !== window.parent || !isDiagramRequest(event.data) || target.childElementCount > 0) return;
    draw(event.data).catch((error: unknown) => {
      reply({ kind: 'error', message: error instanceof Error ? error.message : 'This diagram could not be drawn.' });
    });
  });
  reply({ kind: 'ready' });
}
