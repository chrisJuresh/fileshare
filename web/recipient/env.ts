// Browser capability detection and the optional automation hook.

export interface DirectoryPickerWindow {
  showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite'; id?: string; startIn?: string }) => Promise<FileSystemDirectoryHandle>;
}

/**
 * Optional hook for automated tests. A test injects `window.__fileshareTest = { ... }` before the page
 * loads (e.g. Playwright `addInitScript`); the app then fills in `state()`. Nothing is exposed unless
 * the object already exists.
 */
export interface FileshareTestHook {
  /** Replaces the directory picker (Chromium path), e.g. with an OPFS directory handle. */
  pickDirectory?: () => Promise<FileSystemDirectoryHandle>;
  /** Overrides the "no peer data" delay before the webseed fallback is added (default 10 000 ms). */
  webseedAfterMs?: number;
  /** Set by the app. */
  state?: () => TestState;
}

export interface TestState {
  phase: string;
  peerId: string | null;
  saveMode: SaveMode;
  selected: number[];
  progress: number;
  done: boolean;
  /** Chromium path: every selected file written to the picked folder. */
  saved: boolean;
  uploaded: number;
  downloaded: number;
  peerBytes: number;
  webseedBytes: number;
  webseedActive: boolean;
  numPeers: number;
  liveConnected: boolean;
  error: string | null;
}

export function testHook(): FileshareTestHook | undefined {
  const h = (window as unknown as { __fileshareTest?: unknown }).__fileshareTest;
  return h && typeof h === 'object' ? (h as FileshareTestHook) : undefined;
}

export type SaveMode = 'directory' | 'serviceworker' | 'none';

export function detectSaveMode(): SaveMode {
  const w = window as unknown as DirectoryPickerWindow;
  if (testHook()?.pickDirectory || typeof w.showDirectoryPicker === 'function') return 'directory';
  if ('serviceWorker' in navigator && window.isSecureContext) return 'serviceworker';
  return 'none';
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  const hook = testHook()?.pickDirectory;
  if (hook) return hook();
  const w = window as unknown as DirectoryPickerWindow;
  if (!w.showDirectoryPicker) throw new Error('Folder picking is not supported in this browser');
  return w.showDirectoryPicker({ mode: 'readwrite', id: 'fileshare', startIn: 'downloads' });
}

export function hasWebRTC(): boolean {
  return typeof RTCPeerConnection === 'function';
}

export function isPhone(): boolean {
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const smallScreen = (window.screen?.width ?? window.innerWidth) < 600;
  const ua = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  return ua || coarse || smallScreen;
}

export async function storageEstimate(): Promise<{ quota: number; usage: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || typeof est.quota !== 'number') return null;
    return { quota: est.quota, usage: est.usage ?? 0 };
  } catch {
    return null;
  }
}

export async function requestPersist(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true;
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
