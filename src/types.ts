// Shared DTOs and enums. Imported by server code AND the web frontends (keep it dependency-free).

export type ItemStatus =
  | 'incoming'
  | 'stabilising'
  | 'hashing'
  | 'snapshotting'
  | 'ready'
  | 'error'
  | 'deleted';

/** Statuses a share can be created for. The torrent info exists from `snapshotting` on; the snapshot
 *  wait only gates removal of the PC outbox copy, not sharing. */
export const SHAREABLE_STATUSES: readonly ItemStatus[] = ['snapshotting', 'ready'];

export interface FileEntry {
  /** Path relative to the torrent root, '/'-separated (for a single-file item: the file name). */
  path: string;
  length: number;
}

export interface ItemDto {
  id: string;
  name: string;
  kind: 'file' | 'dir';
  source: 'outbox' | 'upload';
  status: ItemStatus;
  error: string | null;
  totalBytes: number;
  fileCount: number;
  createdAt: number;
  readyAt: number | null;
  /** 0..1 while hashing, otherwise null. */
  progress: number | null;
  activeShares: number;
}

export interface ShareStatsDto {
  serverBytesWebseed: number;
  serverBytesP2p: number;
  peerBytes: number;
  completedDownloads: number;
  peakSwarm: number;
  lastActivityAt: number | null;
}

export interface ShareDto {
  id: string;
  itemId: string;
  itemName: string;
  torrentName: string;
  infoHash: string;
  url: string;
  hasPassword: boolean;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  state: 'active' | 'expired' | 'revoked';
  stats: ShareStatsDto;
}

export interface UnlockResponse {
  token: string;
  infoHash: string;
  name: string;
  totalBytes: number;
  pieceLength: number;
  files: FileEntry[];
  torrentUrl: string;
  magnet: string;
  announce: { ws: string; http: string };
  webseed: string;
  iceServers: { urls: string }[];
  expiresAt: number | null;
}

export interface ShareStatusResponse {
  status: 'locked' | 'open' | 'gone';
  passwordRequired: boolean;
}

export type PeerKind = 'server' | 'browser' | 'client';

export interface SwarmPeer {
  id: string;
  label: string;
  kind: PeerKind;
  progress: number;
  down: number;
  up: number;
  uploaded: number;
}

export interface SwarmSnapshot {
  peers: SwarmPeer[];
  totals: { peers: number; serverBytes: number; peerBytes: number; completed: number };
}

// --- WebSocket messages (docs/ARCHITECTURE.md §8) ---
export type ClientMsg =
  | { t: 'hello'; token: string; peerId: string; nick?: string }
  | { t: 'stats'; progress: number; down: number; up: number; uploaded: number; downloaded: number; done: boolean }
  | { t: 'nick'; nick: string };

export type ServerMsg = { t: 'swarm'; you: string } & SwarmSnapshot;

export interface AdminLiveMsg {
  t: 'live';
  upload: { capBps: number; currentBps: number };
  shares: Record<string, SwarmSnapshot>;
  items: { id: string; status: ItemStatus; progress: number | null }[];
}

export interface DiskStatus {
  label: string;
  path: string;
  mounted: boolean;
  total: number;
  free: number;
  usedFraction: number;
  warn: boolean;
  note?: string;
}

export interface ResticStatus {
  repoInitialised: boolean;
  lastBackupAt: number | null;
  lastSnapshotId: string | null;
  lastBackupOk: boolean | null;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
  lastForgetAt: number | null;
  paused: boolean;
  pendingRequests: number;
}

export interface StatusDto {
  disks: DiskStatus[];
  restic: ResticStatus;
  syncthing: { reachable: boolean; pcConnected: boolean | null; folderState: string | null };
  version: string;
}

export interface StatsDto {
  upload: { capBps: number; capacityBps: number | null; currentBps: number };
  totals: { serverBytes: number; peerBytes: number; savedFraction: number; completedDownloads: number };
  shares: (ShareStatsDto & { shareId: string; itemName: string })[];
}

export interface SettingsDto {
  uploadCapBps: number;
  uploadCapacityBps: number | null;
  uploadMeasuredAt: number | null;
}
