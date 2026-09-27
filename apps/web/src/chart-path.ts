export interface ChartPoint { x: number; y: number }

// Shape-preserving cubic interpolation: passes through the observations without
// introducing peaks or negative troughs between adjacent data points.
export function smoothPath(points: ChartPoint[]): string {
  if (!points.length) return '';
  const slopes = points.slice(1).map((p, i) => (p.y - points[i]!.y) / (p.x - points[i]!.x));
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0] ?? 0;
    if (i === points.length - 1) return slopes[i - 1]!;
    const a = slopes[i - 1]!, b = slopes[i]!;
    return a * b <= 0 ? 0 : 2 * a * b / (a + b);
  });
  return points.reduce((path, p, i) => {
    if (!i) return `M${p.x},${p.y}`;
    const previous = points[i - 1]!;
    const dx = (p.x - previous.x) / 3;
    return `${path} C${previous.x + dx},${previous.y + tangents[i - 1]! * dx} ${p.x - dx},${p.y - tangents[i]! * dx} ${p.x},${p.y}`;
  }, '');
}
