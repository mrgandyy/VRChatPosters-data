// FBT Social poster numbering (scheme 2, Oct 2026).
//
// Poster numbers follow the walk through the world: sidewalk + entrance first, then the arrival
// hall, the lower club floor, and the upper club (balcony level). Standard groups get the first 11
// (entrance + arrival); Premium/Headliner get all 32.
//
// A poster number is what people see in Discord and on the website. An atlas CELL is where that
// artwork sits on the two 4×4 atlas sheets (cells 1–16 sheet A, 17–32 sheet B), and each cell is
// bound to one physical poster in the uploaded world. The world never changes here: only which
// number names which cell. Positions were checked against the world on 15 Oct 2026 (Poster map
// tool, RemodelB review scene): 22 and 27 hang on the main-floor walls, so they sit in the
// 'lower' zone even though their numbers come later. Left and right are as you walk in, facing
// the stage (on the street, facing the club door). Keep identical to fbt-social-web src/lib/posters.ts.

export type Zone = 'entrance' | 'arrival' | 'lower' | 'upper';

export interface PosterSlot { slot: number; cell: number; zone: Zone; where: string }

export const POSTER_NUMBERING = 2;
export const STANDARD_SLOTS = 11;

export const SLOTS: readonly PosterSlot[] = [
  { slot: 1, cell: 29, zone: 'entrance', where: 'Sidewalk, left totem, street side' },
  { slot: 2, cell: 31, zone: 'entrance', where: 'Sidewalk, right totem, street side' },
  { slot: 3, cell: 30, zone: 'entrance', where: 'Sidewalk, left totem, door side (faces the queue)' },
  { slot: 4, cell: 32, zone: 'entrance', where: 'Sidewalk, right totem, door side (faces the queue)' },
  { slot: 5, cell: 27, zone: 'entrance', where: 'Entrance hall, right wall' },
  { slot: 6, cell: 28, zone: 'entrance', where: 'Entrance hall, left wall' },
  { slot: 7, cell: 18, zone: 'arrival', where: 'Arrival hall, right wall, where you land' },
  { slot: 8, cell: 19, zone: 'arrival', where: 'Arrival hall, right wall, toward the club' },
  { slot: 9, cell: 20, zone: 'arrival', where: 'Arrival hall, left wall, toward the club' },
  { slot: 10, cell: 17, zone: 'arrival', where: 'Club doorway, right wall' },
  { slot: 11, cell: 1, zone: 'arrival', where: 'Club doorway, left wall' },
  { slot: 12, cell: 2, zone: 'lower', where: 'Main floor, left wall, toward the back' },
  { slot: 13, cell: 4, zone: 'lower', where: 'Main floor, right wall, toward the back' },
  { slot: 14, cell: 3, zone: 'lower', where: 'Main floor, right wall, near the stage' },
  { slot: 15, cell: 21, zone: 'lower', where: 'Main floor, left wall, middle' },
  { slot: 16, cell: 22, zone: 'lower', where: 'Main floor, stage wall, right of the stage' },
  { slot: 17, cell: 25, zone: 'upper', where: 'Upper walkway, back wall, left (faces the stage)' },
  { slot: 18, cell: 6, zone: 'upper', where: 'Left balcony, back end' },
  { slot: 19, cell: 14, zone: 'upper', where: 'Left balcony, toward the back' },
  { slot: 20, cell: 13, zone: 'upper', where: 'Left balcony, middle' },
  { slot: 21, cell: 12, zone: 'upper', where: 'Left balcony, toward the stage' },
  { slot: 22, cell: 23, zone: 'lower', where: 'Main floor, left wall, near the stage' },
  { slot: 23, cell: 10, zone: 'upper', where: 'Upper stage wall, far left (end of the left balcony)' },
  { slot: 24, cell: 9, zone: 'upper', where: 'Upper stage wall, left, above the stairs' },
  { slot: 25, cell: 8, zone: 'upper', where: 'Upper stage wall, right, above the stairs' },
  { slot: 26, cell: 11, zone: 'upper', where: 'Upper stage wall, far right (end of the right balcony)' },
  { slot: 27, cell: 24, zone: 'lower', where: 'Main floor, right wall, at the back' },
  { slot: 28, cell: 15, zone: 'upper', where: 'Right balcony, toward the stage' },
  { slot: 29, cell: 5, zone: 'upper', where: 'Right balcony, middle' },
  { slot: 30, cell: 7, zone: 'upper', where: 'Right balcony, toward the back' },
  { slot: 31, cell: 16, zone: 'upper', where: 'Right balcony, back end' },
  { slot: 32, cell: 26, zone: 'upper', where: 'Upper walkway, back wall, right (faces the stage)' },
];

const BY_SLOT = new Map(SLOTS.map(s => [s.slot, s]));
const BY_CELL = new Map(SLOTS.map(s => [s.cell, s]));

/** Atlas cell (1–32) that shows poster number `slot`. */
export function cellOf(slot: number): number {
  const s = BY_SLOT.get(slot);
  if (!s) throw new Error(`No poster ${slot}.`);
  return s.cell;
}
/** Poster number shown for atlas cell `cell`. */
export function slotOfCell(cell: number): number {
  const s = BY_CELL.get(cell);
  if (!s) throw new Error(`No atlas cell ${cell}.`);
  return s.slot;
}
export const slotInfo = (slot: number): PosterSlot | undefined => BY_SLOT.get(slot);

export const ZONE_ORDER: readonly Zone[] = ['entrance', 'arrival', 'lower', 'upper'];
export const ZONE_LABEL: Record<Zone, string> = {
  entrance: 'Entrance & sidewalk', arrival: 'Arrival hall & club doorway', lower: 'Main dance floor', upper: 'Balconies & upper walkway',
};
export const LEFT_RIGHT = 'Left and right are as you walk in, facing the stage (on the street, facing the club door).';

/** Numbers in a zone, in order. */
export const zoneSlots = (zone: Zone) => SLOTS.filter(s => s.zone === zone).map(s => s.slot);

/** "12–16, 22, 27": runs of consecutive numbers joined with an en dash. */
export function slotList(nums: readonly number[]): string {
  const out: string[] = [];
  const sorted = [...nums].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    out.push(j > i ? `${sorted[i]}–${sorted[j]}` : String(sorted[i]));
    i = j;
  }
  return out.join(', ');
}

/** The poster map as a Discord message: zones in walking order, with who can use them. */
export function posterMap(siteUrl?: string): string {
  const lines = ['**Poster map** (numbered in the order you walk in)', `_${LEFT_RIGHT}_`];
  for (const zone of ZONE_ORDER) {
    const list = SLOTS.filter(s => s.zone === zone);
    const tier = list.every(s => s.slot <= STANDARD_SLOTS) ? 'every club' : 'Premium & Headliner';
    lines.push(`\n__${ZONE_LABEL[zone]}__ · ${slotList(list.map(s => s.slot))} · ${tier}`);
    for (const s of list) lines.push(`\`${String(s.slot).padStart(2, ' ')}\` ${s.where}`);
  }
  if (siteUrl) lines.push(`\nPhotos of every spot and floor plans: ${siteUrl.replace(/\/$/, '')}/help#posters`);
  return lines.join('\n');
}
