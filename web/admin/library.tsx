// Library tab: items table with inline rename, delete, retry, file list, "Add files", "Share", and
// dragging rows onto a folder row ("Add from library").
import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { SHAREABLE_STATUSES, type FileEntry, type ItemDto } from '../../src/types.ts';
import { addableItems, canReceiveItems, dragSource, useItemDrop, type AddItemsRequest } from './add-items.tsx';
import { api, errorMessage } from './api.ts';
import { fmtBytes, fmtDate } from './format.ts';
import { ConfirmDialog, Modal, Progress, StatusBadge, useNotify } from './ui.tsx';
import { addFilesBatchKey, UploadBox } from './upload.tsx';

function RenameCell(props: { item: ItemDto; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(props.item.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notify = useNotify();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const save = async (): Promise<void> => {
    const n = name.trim() === name ? name : name.trim();
    if (!n || n === props.item.name) return props.onCancel();
    setBusy(true);
    try {
      await api('PATCH', `/api/admin/items/${encodeURIComponent(props.item.id)}`, { name: n });
      notify(`Renamed to “${n}”`);
      props.onDone();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <form
      class="rename"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        type="text"
        value={name}
        aria-label={`New name for ${props.item.name}`}
        maxLength={200}
        disabled={busy}
        ref={input}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            props.onCancel();
          }
        }}
      />
      <button type="submit" class="btn btn-small btn-primary" disabled={busy}>
        Save
      </button>
      <button type="button" class="btn btn-small" onClick={props.onCancel} disabled={busy}>
        Cancel
      </button>
      {error && <p class="form-error" role="alert">{error}</p>}
    </form>
  );
}

function FilesRow(props: { item: ItemDto; files: FileEntry[] | 'loading' | string }) {
  return (
    <tr class="detail-row">
      <td colSpan={6}>
        {props.files === 'loading' ? (
          <p class="muted">Loading files…</p>
        ) : typeof props.files === 'string' ? (
          <p class="form-error">{props.files}</p>
        ) : (
          <ul class="file-list">
            {props.files.slice(0, 500).map((f) => (
              <li key={f.path}>
                <span class="file-path">{f.path}</span> <span class="muted">{fmtBytes(f.length)}</span>
              </li>
            ))}
            {props.files.length > 500 && <li class="muted">…and {props.files.length - 500} more</li>}
          </ul>
        )}
      </td>
    </tr>
  );
}

/** Upload more files into a ready folder item. Its share links stay the same and show the new files. */
function AddFilesDialog(props: { item: ItemDto | null; onClose: () => void; onAdded: () => void }) {
  const item = props.item;
  return (
    <Modal open={item !== null} title={`Add files to “${item?.name ?? ''}”`} onClose={props.onClose} wide>
      {item && (
        <>
          <p>
            New files go into the folder next to what is there. A file or folder with the same name as an existing one is refused:
            rename it first.
          </p>
          <p class="muted small">
            {item.activeShares > 0
              ? `The ${item.activeShares} active link${item.activeShares === 1 ? '' : 's'} stay the same and show the new files once they are processed. `
              : ''}
            People who already have the earlier files in a torrent app can download the .torrent again into the same folder: it keeps
            what they have and only fetches the new files. A download running in a browser starts again.
          </p>
          <UploadBox
            batchKey={addFilesBatchKey(item.id)}
            height={320}
            note="Files or folders. Uploads resume after interruptions (keep this dialog open until they finish)."
            finish={async (batchId, ok) => {
              await api('POST', `/api/admin/items/${encodeURIComponent(item.id)}/add-files`, { batchId });
              props.onAdded();
              props.onClose();
              return `Adding ${ok} file${ok === 1 ? '' : 's'} to “${item.name}”. Its links show them once hashing is done.`;
            }}
          />
        </>
      )}
    </Modal>
  );
}

export function Library(props: {
  items: ItemDto[] | null;
  error: string | null;
  onChanged: () => void;
  onShare: (i: ItemDto) => void;
  onAddItems: (r: AddItemsRequest) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ItemDto | null>(null);
  const [adding, setAdding] = useState<ItemDto | null>(null);
  const [files, setFiles] = useState<Record<string, FileEntry[] | 'loading' | string>>({});
  const notify = useNotify();
  const drop = useItemDrop((targetId, dragged) => props.onAddItems({ targetId, preselect: [dragged] }));

  // A folder that is having files or items added gets a new file list: drop the cached one.
  const hashing = (props.items ?? []).filter((i) => i.status === 'hashing' && files[i.id]).map((i) => i.id);
  useEffect(() => {
    if (hashing.length > 0) setFiles((f) => Object.fromEntries(Object.entries(f).filter(([id]) => !hashing.includes(id))));
  }, [hashing.join(',')]);

  const toggleFiles = async (item: ItemDto): Promise<void> => {
    if (files[item.id]) {
      const { [item.id]: _drop, ...rest } = files;
      return setFiles(rest);
    }
    setFiles((f) => ({ ...f, [item.id]: 'loading' }));
    try {
      const list = await api<FileEntry[]>('GET', `/api/admin/items/${encodeURIComponent(item.id)}/files`);
      setFiles((f) => ({ ...f, [item.id]: list }));
    } catch (e) {
      setFiles((f) => ({ ...f, [item.id]: errorMessage(e) }));
    }
  };

  const retry = async (item: ItemDto): Promise<void> => {
    try {
      await api('POST', `/api/admin/items/${encodeURIComponent(item.id)}/retry`);
      notify(`Retrying “${item.name}”`);
      props.onChanged();
    } catch (e) {
      notify(errorMessage(e), 'error');
    }
  };

  if (props.error) return <p class="form-error" role="alert">{props.error}</p>;
  if (!props.items) return <p class="muted">Loading…</p>;
  if (props.items.length === 0) {
    return (
      <div class="empty">
        <p>The library is empty.</p>
        <p class="muted">Drop files into the outbox folder on your PC, or use the Upload tab.</p>
      </div>
    );
  }

  return (
    <>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" class="num">Size</th>
              <th scope="col" class="num">Files</th>
              <th scope="col">Status</th>
              <th scope="col" class="hide-sm">Added</th>
              <th scope="col">
                <span class="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {props.items.map((item) => (
              <Fragment key={item.id}>
                <tr
                  class={drop.overKey === item.id ? 'drop-over' : undefined}
                  {...dragSource(item, renaming !== item.id)}
                  {...drop.propsFor(item.id, canReceiveItems(item) ? item.id : undefined)}
                >
                  <td class="name-cell">
                    {renaming === item.id ? (
                      <RenameCell
                        item={item}
                        onCancel={() => setRenaming(null)}
                        onDone={() => {
                          setRenaming(null);
                          props.onChanged();
                        }}
                      />
                    ) : (
                      <>
                        <span class="item-name">{item.name}</span>
                        {item.kind === 'dir' && <span class="muted"> /</span>}
                        {item.activeShares > 0 && (
                          <span class="pill" title="Active share links">
                            {item.activeShares} link{item.activeShares === 1 ? '' : 's'}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td class="num">{item.totalBytes > 0 ? fmtBytes(item.totalBytes) : '–'}</td>
                  <td class="num">
                    {item.fileCount === 0 ? (
                      '–'
                    ) : item.status === 'incoming' || item.status === 'stabilising' || item.status === 'hashing' ? (
                      item.fileCount
                    ) : (
                      <button
                        type="button"
                        class="btn-link"
                        aria-expanded={Boolean(files[item.id])}
                        aria-label={`${item.fileCount} file${item.fileCount === 1 ? '' : 's'}: show list`}
                        onClick={() => void toggleFiles(item)}
                      >
                        {item.fileCount}
                      </button>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={item.status} progress={item.progress} />
                    {item.status === 'hashing' && item.progress !== null && <Progress value={item.progress} label={`Hashing ${item.name}`} />}
                    {item.status === 'error' && item.error && <div class="error-text">{item.error}</div>}
                  </td>
                  <td class="hide-sm">{fmtDate(item.createdAt)}</td>
                  <td class="actions-cell">
<div class="row-actions">
                    {SHAREABLE_STATUSES.includes(item.status) && (
                      <button type="button" class="btn btn-small btn-primary" onClick={() => props.onShare(item)}>
                        Share
                      </button>
                    )}
                    {item.kind === 'dir' && item.status === 'ready' && (
                      <button type="button" class="btn btn-small" onClick={() => setAdding(item)} aria-label={`Add files to ${item.name}`}>
                        Add files
                      </button>
                    )}
                    {canReceiveItems(item) && addableItems(props.items ?? [], item).length > 0 && (
                      <button
                        type="button"
                        class="btn btn-small"
                        onClick={() => props.onAddItems({ targetId: item.id, preselect: [] })}
                        aria-label={`Add library items to ${item.name}`}
                      >
                        Add from library
                      </button>
                    )}
                    {item.status === 'error' && (
                      <button type="button" class="btn btn-small" onClick={() => void retry(item)}>
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      class="btn btn-small"
                      onClick={() => setRenaming(item.id)}
                      disabled={renaming !== null}
                      aria-label={`Rename ${item.name}`}
                    >
                      Rename
                    </button>
                    {/* Outbox items keep their outbox entry until ready; deleting earlier would re-ingest it
                        (the server refuses with 409). Error items can go once removed from the PC outbox. */}
                    {(item.source !== 'outbox' || item.status === 'ready' || item.status === 'error') && (
                      <button type="button" class="btn btn-small btn-danger-outline" onClick={() => setDeleting(item)} aria-label={`Delete ${item.name}`}>
                        Delete
                      </button>
                    )}
                  </div>
</td>
                </tr>
                {files[item.id] && <FilesRow item={item} files={files[item.id]!} />}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <AddFilesDialog
        item={adding}
        onClose={() => setAdding(null)}
        onAdded={() => {
          const id = adding?.id;
          if (id) setFiles(({ [id]: _drop, ...rest }) => rest);
          props.onChanged();
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        title="Delete item?"
        danger
        confirmLabel="Delete and revoke links"
        message={
          deleting && (
            <>
              <p>
                Delete <strong>{deleting.name}</strong> ({fmtBytes(deleting.totalBytes)}) from the library?
              </p>
              <p>
                {deleting.activeShares > 0
                  ? `This revokes its ${deleting.activeShares} active share link${deleting.activeShares === 1 ? '' : 's'}: recipients will no longer be able to download it.`
                  : 'Any share links for it are revoked.'}
              </p>
              <p class="muted">Existing snapshots keep a copy until snapshot retention removes it.</p>
            </>
          )
        }
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          await api('DELETE', `/api/admin/items/${encodeURIComponent(deleting.id)}`);
          notify(`Deleted “${deleting.name}”`);
          props.onChanged();
        }}
      />
    </>
  );
}
