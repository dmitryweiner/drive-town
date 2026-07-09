import type { Round } from '../game/Round';

/** Миникарта в углу: улицы, позиция игрока и флажок цели. */
export class Minimap {
  constructor(private readonly canvas: HTMLCanvasElement) {}

  render(round: Round): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const map = round.plan.map;
    // границы города
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const n of map.nodes) {
      xMin = Math.min(xMin, n.x);
      xMax = Math.max(xMax, n.x);
      yMin = Math.min(yMin, n.y);
      yMax = Math.max(yMax, n.y);
    }
    const pad = 14;
    const scale = Math.min((w - 2 * pad) / Math.max(1, xMax - xMin), (h - 2 * pad) / Math.max(1, yMax - yMin));
    const toX = (x: number): number => pad + (x - xMin) * scale + (w - 2 * pad - (xMax - xMin) * scale) / 2;
    const toY = (y: number): number => pad + (y - yMin) * scale + (h - 2 * pad - (yMax - yMin) * scale) / 2;

    // улицы
    ctx.strokeStyle = 'rgba(230,230,230,0.55)';
    ctx.lineCap = 'round';
    ctx.lineWidth = 3;
    for (const e of map.edges) {
      const a = map.nodes[e.a];
      const b = map.nodes[e.b];
      ctx.beginPath();
      ctx.moveTo(toX(a.x), toY(a.y));
      ctx.lineTo(toX(b.x), toY(b.y));
      ctx.stroke();
    }

    // цель: красный флажок
    const g = round.plan.goal;
    ctx.fillStyle = '#ff5a5a';
    ctx.strokeStyle = '#ffdddd';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(toX(g.x), toY(g.y));
    ctx.lineTo(toX(g.x), toY(g.y) - 9);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(toX(g.x), toY(g.y) - 9);
    ctx.lineTo(toX(g.x) + 7, toY(g.y) - 6.5);
    ctx.lineTo(toX(g.x), toY(g.y) - 4);
    ctx.closePath();
    ctx.fill();

    // игрок: жёлтая точка с «носом» по курсу
    const c = round.car;
    const px = toX(c.position.x);
    const py = toY(c.position.y);
    ctx.fillStyle = '#ffce4d';
    ctx.beginPath();
    ctx.arc(px, py, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffce4d';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + Math.cos(c.heading) * 8, py + Math.sin(c.heading) * 8);
    ctx.stroke();
  }
}
