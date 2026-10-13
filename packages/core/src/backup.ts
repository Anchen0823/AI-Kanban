export const BACKUP_PACKAGE_VERSION = 1;
export const BACKUP_MAX_BYTES = 128 * 1024 * 1024;
export type BackupPhase = 'queued' | 'snapshot' | 'encrypting' | 'uploading' | 'verifying' | 'downloading' | 'importing' | 'done' | 'error';
export interface BackupJob {
  id: string; kind: 'upload' | 'download' | 'test'; phase: BackupPhase;
  createdAt: string; updatedAt: string; localName?: string; remoteId?: string;
  error?: string; retryAt?: string; attempts: number; target: string; automaticDay?: string;
}
export interface BackupSettings {
  endpoint: string; username: string; enabled: boolean; deviceId: string;
  unlocked: boolean; persistentSecrets: boolean; lastLocalAt?: string; lastCloudAt?: string;
  syncPaused: boolean;
  authBlocked: boolean;
}
export interface RemoteBackup { id: string; name: string; bytes: number; modified: string }
