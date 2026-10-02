/**
 * A one-line title that shows the rest of itself when its row is hovered or
 * focused.
 *
 * At rest it is cut with an ellipsis like any other. When the row it sits in
 * (the nearest `group`) is hovered or focused, the ellipsis goes and the text
 * slides left by exactly as much as was hidden, at a speed a person can read,
 * after a short pause so a pointer passing over does not set every row moving.
 * Leaving brings it back quickly. A title that fits never moves.
 *
 * Reduced motion needs nothing here: the stylesheet takes every transition to
 * zero for it, so the end of the title simply appears.
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { slideTiming } from '../slide.js';

export function SlidingTitle({ text, className = '' }: { text: string; className?: string }) {
  const outer = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [hidden, setHidden] = useState(0);

  useLayoutEffect(() => {
    const box = outer.current;
    const line = inner.current;
    if (!box || !line) return;
    // scrollWidth is the whole line even while the ellipsis is cutting it.
    const measure = () => setHidden(Math.max(0, Math.ceil(line.scrollWidth - box.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [text]);

  const { seconds } = slideTiming(hidden);

  return (
    <span ref={outer} className={`block overflow-hidden ${className}`} title={hidden > 0 ? text : undefined}>
      <span
        ref={inner}
        data-slides={hidden > 0 ? 'true' : undefined}
        style={
          hidden > 0
            ? ({ '--slide': `-${hidden}px`, '--slide-time': `${seconds}s` } as React.CSSProperties)
            : undefined
        }
        className={[
          'block truncate transition-transform duration-200 ease-out',
          hidden > 0 &&
            [
              'group-hover:w-max group-hover:text-clip group-hover:translate-x-(--slide)',
              'group-hover:delay-300 group-hover:duration-(--slide-time) group-hover:ease-linear',
              'group-focus-visible:w-max group-focus-visible:text-clip group-focus-visible:translate-x-(--slide)',
              'group-focus-visible:delay-300 group-focus-visible:duration-(--slide-time) group-focus-visible:ease-linear',
            ].join(' '),
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {text}
      </span>
    </span>
  );
}
