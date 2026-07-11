/** Координаты как в driving-trainer: x — на восток, y — на юг (canvas),
 * heading 0 = +x. Все улицы осеориентированы. */
export type Dir = 'N' | 'E' | 'S' | 'W';

export type VehicleKind = 'car' | 'motorcycle' | 'bicycle';

export type LightState = 'red' | 'red-yellow' | 'green' | 'yellow';

/** Регулирование перекрёстка:
 * none — нерегулируемый (правило правой руки),
 * lights — светофор,
 * priority — главная дорога вдоль оси mainAxis, на второстепенных minorSign,
 * roundabout — круговое движение (въезжающий уступает кольцу). */
export type NodeControl = 'none' | 'lights' | 'priority' | 'roundabout';

export type MinorSign = 'stop' | 'yield';

export interface NodeSpec {
  x: number;
  y: number;
  control?: NodeControl;
  /** Ось главной дороги для control 'priority': h — восток-запад, v — север-юг. */
  mainAxis?: 'h' | 'v';
  /** Знак на второстепенных подъездах при 'priority'. */
  minorSign?: MinorSign;
  /** Сдвиг фазы светофора, с. */
  lightOffset?: number;
  /** Знак «разворот запрещён» (431) на всех подъездах узла. */
  noUTurn?: boolean;
}

export interface EdgeSpec {
  /** Индексы узлов. Ребро строго горизонтально или вертикально. */
  a: number;
  b: number;
  /** Односторонняя улица: движение только a→b. */
  oneWay?: boolean;
  /** Ограничение скорости на ребре, км/ч (нет — городской дефолт 50). */
  speedLimit?: number;
  /** Пешеходные переходы: метры от ЦЕНТРА узла a вдоль ребра. */
  crosswalks?: number[];
  /** ЖД-переезды: метры от ЦЕНТРА узла a вдоль ребра.
   * Перед переездом обязательна полная остановка (как в driving-trainer). */
  railways?: number[];
  /** ЖД-переезды со светофором (метры от центра узла a): стоп-линии нет,
   * ехать нельзя только пока мигает красный (билеты 0673/0674 тренажёра). */
  railLights?: number[];
}

export interface Rect {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface CitySpec {
  nodes: NodeSpec[];
  edges: EdgeSpec[];
  /** Дома внутри кварталов: твёрдые препятствия и декорации. */
  buildings?: Rect[];
}

/** Нарушение не прерывает уровень — только увеличивает счётчик. */
export type ViolationType =
  | 'collision'   // столкновение с участником движения или домом
  | 'off-road'    // выезд за пределы проезжей части
  | 'priority'    // не уступил дорогу
  | 'ran-stop'    // не остановился перед знаком «стоп»
  | 'railway'     // нарушение на ЖД-переезде (без остановки / на мигающий)
  | 'ran-light'   // проехал на запрещающий сигнал
  | 'no-u-turn'   // разворот под знаком «разворот запрещён»
  | 'wrong-way'   // движение по встречной / против односторонней
  | 'reverse'     // движение задним ходом
  | 'speeding'    // превышение скорости
  | 'pedestrian'; // не пропустил пешехода на переходе

export interface Violation {
  type: ViolationType;
  /** Игровое время уровня, с. */
  at: number;
  x: number;
  y: number;
}

export const VIOLATION_LABEL: Record<ViolationType, string> = {
  'collision': 'Столкновение',
  'off-road': 'Выезд с дороги',
  'priority': 'Не уступил дорогу',
  'ran-stop': 'Проезд знака «стоп» без остановки',
  'railway': 'Нарушение на ЖД-переезде',
  'ran-light': 'Проезд на запрещающий сигнал',
  'no-u-turn': 'Разворот под запрещающим знаком',
  'wrong-way': 'Выезд на встречную полосу',
  'reverse': 'Движение задним ходом',
  'speeding': 'Превышение скорости',
  'pedestrian': 'Не пропустил пешехода',
};
