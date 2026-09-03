export const USER_ROLES = ['agent', 'manager', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const LEAD_STATUSES = [
  'new',
  'interested',
  'not_reachable',
  'follow_up',
  'not_interested',
  'converted',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const RECORDING_SOURCES = ['miuiNative', 'fallback'] as const;
export type RecordingSource = (typeof RECORDING_SOURCES)[number];

export const UPLOAD_STATUSES = ['uploaded', 'failed'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];
