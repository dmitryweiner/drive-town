export interface OBB {
  cx: number;
  cy: number;
  hx: number;
  hy: number;
  angle: number;
}

interface Vec {
  x: number;
  y: number;
}

export function obbIntersect(a: OBB, b: OBB): boolean {
  const axes: Vec[] = [
    { x: Math.cos(a.angle), y: Math.sin(a.angle) },
    { x: -Math.sin(a.angle), y: Math.cos(a.angle) },
    { x: Math.cos(b.angle), y: Math.sin(b.angle) },
    { x: -Math.sin(b.angle), y: Math.cos(b.angle) },
  ];
  for (const axis of axes) {
    const ap = projectOBB(a, axis);
    const bp = projectOBB(b, axis);
    if (ap.max < bp.min || bp.max < ap.min) return false;
  }
  return true;
}

function projectOBB(o: OBB, axis: Vec): { min: number; max: number } {
  const center = o.cx * axis.x + o.cy * axis.y;
  const ux = Math.cos(o.angle) * axis.x + Math.sin(o.angle) * axis.y;
  const uy = -Math.sin(o.angle) * axis.x + Math.cos(o.angle) * axis.y;
  const r = Math.abs(ux) * o.hx + Math.abs(uy) * o.hy;
  return { min: center - r, max: center + r };
}

export function pointInOBB(p: Vec, o: OBB): boolean {
  const dx = p.x - o.cx;
  const dy = p.y - o.cy;
  const u = dx * Math.cos(o.angle) + dy * Math.sin(o.angle);
  const v = -dx * Math.sin(o.angle) + dy * Math.cos(o.angle);
  return Math.abs(u) <= o.hx && Math.abs(v) <= o.hy;
}
