// Upload tab: Uppy Dashboard + tus (resumable, 50 MiB chunks), files and folders.
// Flow: create a batch before the first file starts → upload with meta {batchId, relativePath,
// filename} → when every file of the round succeeded, complete the batch (its top-level entries
// become library items).
import Uppy from '@uppy/core';
import Dashboard from '@uppy/dashboard';
import Tus from '@uppy/tus';
import { useEffect, useRef } from 'preact/hooks';
import { api, ApiError, errorMessage } from './api.ts';
import { useNotify } from './ui.tsx';

const CHUNK = 50 * 1024 * 1024;
/** The open batch survives reloads: resumed tus uploads keep the batch they were created in. */
const BATCH_KEY = 'fileshare.upload.batchId';
const BAD_UPLOAD_CHARS = /[#?%\\\u0000-\u001f\u007f]/;

type Meta = { batchId?: string; relativePath?: string | null; filename?: string; [k: string]: unknown };

/** Uppy gives '/dir/a.txt' for drops, 'dir/a.txt' for the picker, null (or "null") for plain files. */
export function cleanRelativePath(rel: unknown, name: string): string {
  if (typeof rel !== 'string' || rel === '' || rel === 'null') return name;
  return rel.replace(/^\/+/, '');
}

function storedBatch(): string | null {
  try {
    return localStorage.getItem(BATCH_KEY);
  } catch {
    return null;
  }
}
function storeBatch(id: string | null): void {
  try {
    if (id) localStorage.setItem(BATCH_KEY, id);
    else localStorage.removeItem(BATCH_KEY);
  } catch {
    /* storage unavailable: resumes after a reload may then need a new round */
  }
}

/** Reuse the remembered batch while the server still has it open; otherwise start a new one. */
async function openBatch(): Promise<string> {
  const remembered = storedBatch();
  if (remembered && /^[a-z2-7]{26}$/.test(remembered)) {
    try {
      const b = await api<{ id: string; status: string }>('GET', `/api/admin/uploads/batches/${remembered}`);
      if (b.status === 'open') return remembered;
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 404) throw e;
    }
  }
  const r = await api<{ id: string }>('POST', '/api/admin/uploads/batches');
  storeBatch(r.id);
  return r.id;
}

export function Upload(props: { onItemsChanged: () => void }) {
  const target = useRef<HTMLDivElement>(null);
  const notify = useNotify();
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const changedRef = useRef(props.onItemsChanged);
  changedRef.current = props.onItemsChanged;

  useEffect(() => {
    if (!target.current) return;
    let batchId: string | null = null;
    const uppy = new Uppy<Meta, Record<string, never>>({
      autoProceed: false,
      allowMultipleUploadBatches: true,
      onBeforeFileAdded: (file) => {
        const rel = cleanRelativePath(file.meta.relativePath, file.name ?? '');
        const bad = rel.split('/').find((seg) => seg === '.' || seg === '..' || seg.trim() !== seg || BAD_UPLOAD_CHARS.test(seg));
        if (bad !== undefined) {
          uppy.info(`“${rel}” can't be uploaded: names may not contain # ? % or \\, or start/end with spaces. Rename it first.`, 'error', 8000);
          return false;
        }
        return true;
      },
    });
    uppy.use(Dashboard, {
      inline: true,
      target: target.current,
      width: '100%',
      height: 460,
      theme: 'auto',
      fileManagerSelectionType: 'both',
      proudlyDisplayPoweredByUppy: false,
      note: 'Files or whole folders. Uploads resume after interruptions. Each top-level file or folder becomes one library item.',
    });
    uppy.use(Tus, {
      endpoint: '/api/admin/uploads/tus/',
      chunkSize: CHUNK,
      retryDelays: [0, 1000, 3000, 5000, 10_000, 20_000, 30_000, 60_000],
      limit: 3,
      removeFingerprintOnSuccess: true,
      allowedMetaFields: ['batchId', 'relativePath', 'filename'],
    });

    uppy.addPreProcessor(async (fileIDs) => {
      if (!batchId) batchId = await openBatch();
      for (const id of fileIDs) {
        const f = uppy.getFile(id);
        if (!f) continue;
        const name = f.name ?? 'file';
        uppy.setFileMeta(id, { batchId, relativePath: cleanRelativePath(f.meta.relativePath, name), filename: name });
      }
    });

    uppy.on('complete', (result) => {
      const ok = result.successful?.length ?? 0;
      const failed = result.failed?.length ?? 0;
      if (!batchId || ok === 0) return;
      if (failed > 0) {
        notifyRef.current(`${failed} file(s) failed. Retry them; the upload is added to the library once all files are in.`, 'error');
        return;
      }
      const id = batchId;
      void (async () => {
        try {
          await api('POST', `/api/admin/uploads/batches/${encodeURIComponent(id)}/complete`);
          batchId = null;
          storeBatch(null);
          uppy.clear();
          notifyRef.current(`Upload complete: ${ok} file${ok === 1 ? '' : 's'} added. They appear in the Library as they are processed.`);
          changedRef.current();
        } catch (e) {
          // The round can't be completed any more (already added, or unknown): start fresh next time.
          if (e instanceof ApiError && (e.status === 404 || e.status === 409)) {
            batchId = null;
            storeBatch(null);
          }
          notifyRef.current(`Upload finished, but adding it to the library failed: ${errorMessage(e)}`, 'error');
        }
      })();
    });
    uppy.on('error', (e) => notifyRef.current(`Upload error: ${errorMessage(e)}`, 'error'));

    return () => {
      uppy.destroy();
    };
  }, []);

  return (
    <div>
      <div ref={target} class="uppy-host" />
      <p class="muted small">
        Large uploads are sent in 50 MiB pieces. If the connection drops, add the same files again and they resume where they left off.
      </p>
    </div>
  );
}
