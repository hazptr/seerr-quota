/**
 * Public surface of the quota-policy feature (P2-2, `wiki/
 * Feature-04-Quota-Policy.md`). Callers (the admin/member API routes, a
 * later wave) should import from `@/lib/quota`, not reach into individual
 * files here — same convention as `@/lib/audit`'s `index.ts`.
 */
export { BYTES_PER_GB, bytesToGb, gbToBytes } from './units';

export type { ValidationOutcome } from './validation';
export { checkFreeSpaceWarning, readBulkDriveFreeBytes, validateGraceBytes, validateQuotaBytes } from './validation';

export type {
  DefaultChangePreview,
  DefaultChangePreviewMember,
  MemberQuotaChangePreview,
  QuotaChangeEffect,
} from './preview';
export { isOverQuota, overageBytes, previewClearOverride, previewDefaultChange, previewOverrideChange } from './preview';

export type {
  ClearMemberOverrideInput,
  ClearMemberOverrideResult,
  MemberQuotaPolicyView,
  PolicyWriteOutcome,
  QuotaPolicyReadResult,
  QuotaViewer,
  SetGlobalDefaultInput,
  SetGlobalDefaultResult,
  SetMemberOverrideInput,
  SetMemberOverrideResult,
} from './policy';
export {
  clearMemberOverride,
  getGlobalDefaultQuotaBytes,
  getGraceBytes,
  getMemberQuotaPolicy,
  listMemberQuotaPolicies,
  previewGlobalDefaultChange,
  previewMemberClearOverride,
  previewMemberOverrideChange,
  setGlobalDefaultQuota,
  setMemberOverride,
} from './policy';

export type { SeerrNativeQuotaSettings, SeerrNativeQuotaUsage, SeerrNativeQuotaWindowUsage } from './seerrNativeQuota';
export { createSeerrNativeQuotaReader, SeerrNativeQuotaReader } from './seerrNativeQuota';
