/**
 * Draws the diagram blocks of a rendered Markdown kite.
 *
 * Each ```mermaid or ```svg block gets a frame sandboxed with `allow-scripts`
 * only, loading /diagram-frame.html. The frame runs at an opaque origin with no
 * network (see DIAGRAM_FRAME_POLICY on the server), so a diagram can never touch
 * the reader's session or the page around it. The block's source stays in the
 * page, hidden, and comes back with a short note if the frame cannot draw it.
 *
 * Returns a function that puts every block back as it was, for when the
 * document changes, editing starts, or the theme flips.
 */

import {
  DIAGRAM_LANGUAGES,
  DIAGRAM_MESSAGE,
  MAX_DIAGRAM_HEIGHT,
  isDiagramReply,
  type DiagramLanguage,
  type DiagramRequest,
} from './diagram-protocol.js';

/** How long a frame may take to say it is ready before its source is shown instead. */
const READY_TIMEOUT_MS = 10_000;

interface Drawing {
  pre: HTMLPreElement;
  code: HTMLElement;
  frame: HTMLIFrameElement;
  request: DiagramRequest;
  timer: ReturnType<typeof setTimeout>;
  note: HTMLElement | null;
}

function languageOf(code: Element): DiagramLanguage | null {
  for (const language of DIAGRAM_LANGUAGES) {
    if (code.classList.contains(`language-${language}`)) return language;
  }
  return null;
}

export function drawDiagrams(article: HTMLElement, dark: boolean): () => void {
  const drawings = new Map<Window, Drawing>();
  const pending: Drawing[] = [];

  const fail = (drawing: Drawing, reason: string) => {
    clearTimeout(drawing.timer);
    drawing.frame.remove();
    drawing.code.hidden = false;
    drawing.pre.dataset.diagram = 'failed';
    const note = document.createElement('p');
    note.className = 'kite-diagram-note';
    note.textContent = `This diagram could not be drawn. ${reason}`.trim();
    drawing.pre.before(note);
    drawing.note = note;
  };

  for (const code of article.querySelectorAll<HTMLElement>('pre > code')) {
    const language = languageOf(code);
    const pre = code.parentElement;
    if (!language || !(pre instanceof HTMLPreElement)) continue;

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = '/diagram-frame.html';
    frame.title = language === 'mermaid' ? 'Mermaid diagram' : 'SVG diagram';
    frame.className = 'kite-diagram-frame';
    frame.setAttribute('scrolling', 'no');

    code.hidden = true;
    pre.dataset.diagram = 'drawing';
    pre.append(frame);

    const drawing: Drawing = {
      pre,
      code,
      frame,
      request: { type: DIAGRAM_MESSAGE, language, source: code.textContent ?? '', dark },
      timer: setTimeout(() => fail(drawing, 'It took too long.'), READY_TIMEOUT_MS),
      note: null,
    };
    pending.push(drawing);
  }

  const onMessage = (event: MessageEvent) => {
    if (!isDiagramReply(event.data)) return;
    // Only a frame this function made, still holding the page it was given.
    let drawing = event.source instanceof Window ? drawings.get(event.source) : undefined;
    if (!drawing) {
      drawing = pending.find((candidate) => candidate.frame.contentWindow === event.source);
      if (!drawing || !drawing.frame.contentWindow) return;
      drawings.set(drawing.frame.contentWindow, drawing);
    }

    const reply = event.data;
    if (reply.kind === 'ready') {
      clearTimeout(drawing.timer);
      // The frame's origin is opaque, so there is no origin to name here; the
      // contentWindow check above is what makes sure this goes to our frame.
      drawing.frame.contentWindow?.postMessage(drawing.request, '*');
    } else if (reply.kind === 'size') {
      drawing.frame.style.height = `${Math.min(Math.max(reply.height, 1), MAX_DIAGRAM_HEIGHT)}px`;
      drawing.pre.dataset.diagram = 'drawn';
    } else {
      fail(drawing, reply.message);
    }
  };

  window.addEventListener('message', onMessage);

  return () => {
    window.removeEventListener('message', onMessage);
    for (const drawing of pending) {
      clearTimeout(drawing.timer);
      drawing.frame.remove();
      drawing.note?.remove();
      drawing.code.hidden = false;
      delete drawing.pre.dataset.diagram;
    }
  };
}
