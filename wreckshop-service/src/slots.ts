// FBT Social poster numbering (scheme 2, Oct 2026).
//
// Poster numbers follow the walk through the world: sidewalk + entrance first, then the arrival
// hall, the lower club floor, and the upper club (balcony level). Standard groups get the first 11
// (entrance + arrival); Premium/Headliner get all 32.
//
// A poster number is what people see in Discord and on the website. An atlas CELL is where that
// artwork sits on the two 4×4 atlas sheets (cells 1–16 sheet A, 17–32 sheet B), and each cell is
// bound to one physical poster in the uploaded world. The world never changes here: only which
// number names which cell. Positions come from the Remodel A manifest (posters + posterExpansion).

export type Zone = 'entrance' | 'arrival' | 'lower' | 'upper';

export interface PosterSlot { slot: number; cell: number; zone: Zone; where: string }

export const POSTER_NUMBERING = 2;
export const STANDARD_SLOTS = 11;

export const SLOTS: readonly PosterSlot[] = [
  { slot: 1, cell: 29, zone: 'entrance', where: 'Sidewalk totem 1, front (faces arrivals)' },
  { slot: 2, cell: 31, zone: 'entrance', where: 'Sidewalk totem 2, front (faces arrivals)' },
  { slot: 3, cell: 30, zone: 'entrance', where: 'Sidewalk totem 1, back (faces the queue)' },
  { slot: 4, cell: 32, zone: 'entrance', where: 'Sidewalk totem 2, back (faces the queue)' },
  { slot: 5, cell: 27, zone: 'entrance', where: 'Entrance vestibule, east wall' },
  { slot: 6, cell: 28, zone: 'entrance', where: 'Entrance vestibule, west wall' },
  { slot: 7, cell: 18, zone: 'arrival', where: 'Arrival hall east, by the arrival point' },
  { slot: 8, cell: 19, zone: 'arrival', where: 'Arrival hall east, toward the club' },
  { slot: 9, cell: 20, zone: 'arrival', where: 'Arrival hall west, toward the club' },
  { slot: 10, cell: 17, zone: 'arrival', where: 'Club vestibule, east wall' },
  { slot: 11, cell: 1, zone: 'arrival', where: 'Club vestibule, west wall' },
  { slot: 12, cell: 2, zone: 'lower', where: 'Main floor, west wall' },
  { slot: 13, cell: 4, zone: 'lower', where: 'Main floor, east wall' },
  { slot: 14, cell: 3, zone: 'lower', where: 'Main floor, east wall near the stage' },
  { slot: 15, cell: 21, zone: 'lower', where: 'Stage wall, west of the stage' },
  { slot: 16, cell: 22, zone: 'lower', where: 'Stage wall, east of the stage' },
  { slot: 17, cell: 25, zone: 'upper', where: 'Balcony level, front wall west' },
  { slot: 18, cell: 6, zone: 'upper', where: 'West balcony, front' },
  { slot: 19, cell: 14, zone: 'upper', where: 'West balcony' },
  { slot: 20, cell: 13, zone: 'upper', where: 'West balcony, middle' },
  { slot: 21, cell: 12, zone: 'upper', where: 'West balcony, toward the stage' },
  { slot: 22, cell: 23, zone: 'upper', where: 'West balcony, nearest the stage' },
  { slot: 23, cell: 10, zone: 'upper', where: 'Upper stage wall, far west' },
  { slot: 24, cell: 9, zone: 'upper', where: 'Upper stage wall, west' },
  { slot: 25, cell: 8, zone: 'upper', where: 'Upper stage wall, east' },
  { slot: 26, cell: 11, zone: 'upper', where: 'Upper stage wall, far east' },
  { slot: 27, cell: 24, zone: 'upper', where: 'East balcony, nearest the stage' },
  { slot: 28, cell: 15, zone: 'upper', where: 'East balcony, toward the stage' },
  { slot: 29, cell: 5, zone: 'upper', where: 'East balcony, middle' },
  { slot: 30, cell: 7, zone: 'upper', where: 'East balcony' },
  { slot: 31, cell: 16, zone: 'upper', where: 'East balcony, front' },
  { slot: 32, cell: 26, zone: 'upper', where: 'Balcony level, front wall east' },
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

export const ZONE_LABEL: Record<Zone, string> = {
  entrance: 'Entrance & sidewalk', arrival: 'Arrival hall', lower: 'Lower club', upper: 'Upper club',
};

/** The poster map as a Discord message: zones in walking order, with who can use them. */
export function posterMap(): string {
  const lines = ['**Poster map** (numbered in the order you walk in)'];
  for (const zone of ['entrance', 'arrival', 'lower', 'upper'] as Zone[]) {
    const list = SLOTS.filter(s => s.zone === zone);
    const tier = list[0]!.slot <= STANDARD_SLOTS ? 'every group' : 'Premium & Headliner';
    lines.push(`\n__${ZONE_LABEL[zone]}__ · ${list[0]!.slot}–${list[list.length - 1]!.slot} · ${tier}`);
    for (const s of list) lines.push(`\`${String(s.slot).padStart(2, ' ')}\` ${s.where}`);
  }
  return lines.join('\n');
}
