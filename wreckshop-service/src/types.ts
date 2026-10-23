import { STANDARD_SLOTS } from './slots.js';
export type Tier = 'standard' | 'premium';
export type SubmissionStatus = 'submitted' | 'rejected' | 'approved' | 'publishing' | 'failed' | 'live';
export interface Group {
  id: number;
  name: string;
  tier: Tier;
  code: string;
  enabled: number;
  vrchatUrl: string | null;
  agreementVersion: string | null;
  agreementAt: string | null;
  atlasSlot: number;
  revision: number;
  /** 'headliner' on top of premium; null otherwise. */
  level?: string | null;
}
export interface Submission {
  id: number;
  groupId: number;
  slot: number;
  submitterId: string;
  sourcePath: string;
  previewPath: string;
  status: SubmissionStatus;
  previousId: number | null;
  reviewedBy: string | null;
  createdAt: string;
}
export const SLOT_COUNT = 32;
/** Poster numbers a tier may use (numbering scheme 2: walking order, see slots.ts). */
export const maxSlots = (tier: Tier) => tier === 'premium' ? SLOT_COUNT : STANDARD_SLOTS;
export function assertSlot(tier: Tier, slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > maxSlots(tier)) {
    throw new Error(`${tier} groups may assign slots 1–${maxSlots(tier)}.`);
  }
}
