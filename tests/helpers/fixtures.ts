import { CityMap } from '../../src/game/CityMap';
import type { CitySpec, NodeControl } from '../../src/game/types';

/** Крест: центр 0 (0,0), лучи по 100 м: 1 — север, 2 — восток, 3 — юг, 4 — запад.
 * Рёбра: e0 = 1→0 (юг), e1 = 0→2 (восток), e2 = 0→3 (юг), e3 = 4→0 (восток). */
export function cross(opts: {
  control?: NodeControl;
  mainAxis?: 'h' | 'v';
  minorSign?: 'stop' | 'yield';
  oneWayE?: boolean;
  crosswalkS?: boolean;
  /** ЖД-переезд на южном луче (e2) в 50 м от центра. */
  railwayS?: boolean;
} = {}): CityMap {
  const spec: CitySpec = {
    nodes: [
      {
        x: 0, y: 0,
        control: opts.control,
        mainAxis: opts.mainAxis,
        minorSign: opts.minorSign,
        lightOffset: 0,
      },
      { x: 0, y: -100 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
      { x: -100, y: 0 },
    ],
    edges: [
      { a: 1, b: 0 },
      { a: 0, b: 2, oneWay: opts.oneWayE ? true : undefined },
      { a: 0, b: 3, crosswalks: opts.crosswalkS ? [50] : undefined, railways: opts.railwayS ? [50] : undefined },
      { a: 4, b: 0 },
    ],
  };
  return new CityMap(spec);
}
