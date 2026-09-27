import { useLayoutEffect, useRef, useState } from 'react';
import { formatNumber } from './analytics.js';

/** Preserve every digit whenever the available space permits it. */
export function AdaptiveNumber({ value }: { value: number | null | undefined }) {
  const element = useRef<HTMLSpanElement>(null);
  const [compact, setCompact] = useState(false);
  const full = formatNumber(value);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return;
    const measure = () => {
      const style = getComputedStyle(node);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = parseFloat(style.letterSpacing) || 0;
      const width = context.measureText(full).width + spacing * Math.max(0, full.length - 1);
      setCompact(width > node.clientWidth + .5);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    void document.fonts.ready.then(() => { if (node.isConnected) measure(); });
    return () => observer.disconnect();
  }, [full]);
  return <span ref={element} className="adaptive-number" title={full}>{formatNumber(value, compact)}</span>;
}
