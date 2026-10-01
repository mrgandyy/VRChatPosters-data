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
export const SLOT_COUNT = 16;
export const maxSlots = (tier: Tier) => tier === 'premium' ? 16 : 8;
export function assertSlot(tier: Tier, slot: number): void {
  if (!Number.isInteger(slot) || slot < 1 || slot > maxSlots(tier)) {
    throw new Error(`${tier} groups may assign slots 1–${maxSlots(tier)}.`);
  }
}
