// "Add from library": append other ready items to a ready folder item (§4 "add items"), by drag
// and drop (library rows → a folder row or a share row) or from a dialog (keyboard).
import { useEffect, useState } from 'preact/hooks';
import type { ItemDto } from '../../src/types.ts';
import { api, errorMessage } from './api.ts';
import { fmtBytes } from './format.ts';
import { Modal, useNotify } from './ui.tsx';

/** dataTransfer type of a dragged library row (its value is the item id). */
export const ITEM_DRAG_TYPE = 'application/x-fileshare-item';

export const isItemDrag = (e: DragEvent): boolean => Boolean(e.dataTransfer?.types.includes(ITEM_DRAG_TYPE));

/** A folder item that other items can be added to. */
export const canReceiveItems = (item: ItemDto | undefined): item is ItemDto => item?.kind === 'dir' && item.status === 'ready';

/** Items that can be added to `target`. */
export const addableItems = (items: ItemDto[], target: ItemDto): ItemDto[] =>
  items.filter((i) => i.id !== target.id && i.status === 'ready');

/** Props for a draggable library row. */
export function dragSource(item: ItemDto, enabled: boolean) {
  if (!enabled || item.status !== 'ready') return {};
  return {
    draggable: true,
    onDragStart: (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData(ITEM_DRAG_TYPE, item.id);
      e.dataTransfer.setData('text/plain', item.name);
      e.dataTransfer.effectAllowed = 'move';
    },
  };
}

/**
 * Drop targets for a table: `propsFor(key, targetItemId)` gives a row the handlers (or nothing when
 * `targetItemId` is undefined); `overKey` is the row currently dragged over (for highlighting).
 */
export function useItemDrop(onDrop: (targetItemId: string, draggedItemId: string) => void) {
  const [overKey, setOverKey] = useState<string | null>(null);
  const propsFor = (key: string, targetItemId: string | undefined) => {
    if (targetItemId === undefined) return {};
    const accept = (e: DragEvent): void => {
      if (!isItemDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      setOverKey(key);
    };
    return {
      onDragEnter: accept,
      onDragOver: accept,
      onDragLeave: (e: DragEvent) => {
        // Ignore moving between cells of the same row.
        if (e.currentTarget instanceof Node && e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setOverKey((k) => (k === key ? null : k));
      },
      onDrop: (e: DragEvent) => {
        setOverKey(null);
        const id = e.dataTransfer?.getData(ITEM_DRAG_TYPE);
        if (!id) return;
        e.preventDefault();
        if (id !== targetItemId) onDrop(targetItemId, id);
      },
    };
  };
  return { overKey, propsFor };
}

export interface AddItemsRequest {
  targetId: string;
  /** Ticked when the dialog opens (the dragged item). */
  preselect: string[];
}

/** Confirm (and adjust) which library items go into the folder `target`. */
export function AddItemsDialog(props: {
  request: AddItemsRequest | null;
  items: ItemDto[] | null;
  onClose: () => void;
  onAdded: (targetId: string) => void;
}) {
  const items = props.items ?? [];
  const target = props.request ? items.find((i) => i.id === props.request!.targetId) : undefined;
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const notify = useNotify();

  useEffect(() => {
    if (!props.request) return;
    setChosen(new Set(props.request.preselect.filter((id) => id !== props.request!.targetId)));
    setError(null);
    setBusy(false);
  }, [props.request]);

  const open = props.request !== null;
  const candidates = target ? addableItems(items, target) : [];
  const picked = candidates.filter((i) => chosen.has(i.id));
  const keptByLinks = picked.filter((i) => i.activeShares > 0);
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

  const submit = async (): Promise<void> => {
    if (!target || picked.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ removed: string[]; kept: string[] }>('POST', `/api/admin/items/${encodeURIComponent(target.id)}/add-items`, {
        itemIds: picked.map((i) => i.id),
      });
      const keptNames = picked.filter((i) => r.kept.includes(i.id)).map((i) => `“${i.name}”`);
      notify(
        `Adding ${plural(picked.length, 'item')} to “${target.name}”. Its links show them once hashing is done.` +
          (keptNames.length > 0 ? ` ${keptNames.join(', ')} also stay${keptNames.length === 1 ? 's' : ''} in the library (own link).` : ''),
      );
      props.onAdded(target.id);
      props.onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={`Add to “${target?.name ?? ''}”`} onClose={props.onClose} wide>
      {open && !canReceiveItems(target) ? (
        <p class="form-error" role="alert">
          Items can only be added to a ready folder.
        </p>
      ) : (
        target && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {candidates.length === 0 ? (
              <p class="muted">No other ready items in the library.</p>
            ) : (
              <fieldset class="pick-list">
                <legend>Library items to move into this folder</legend>
                {candidates.map((i) => (
                  <label class="check" key={i.id}>
                    <input
                      type="checkbox"
                      checked={chosen.has(i.id)}
                      disabled={busy}
                      onChange={(e) => {
                        const next = new Set(chosen);
                        if ((e.target as HTMLInputElement).checked) next.add(i.id);
                        else next.delete(i.id);
                        setChosen(next);
                      }}
                    />
                    <span>
                      {i.name}
                      {i.kind === 'dir' && <span class="muted"> /</span>} <span class="muted small">{fmtBytes(i.totalBytes)}</span>
                      {i.activeShares > 0 && <span class="pill">{plural(i.activeShares, 'link')}</span>}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <p class="muted small">
              {picked.length > 0
                ? `The chosen items move into “${target.name}” and leave the library as separate items. `
                : ''}
              {keptByLinks.length > 0
                ? `${keptByLinks.map((i) => `“${i.name}”`).join(', ')} ${keptByLinks.length === 1 ? 'has' : 'have'} a link of its own, so ${keptByLinks.length === 1 ? 'it stays' : 'they stay'} too (no extra disk space). `
                : ''}
              {target.activeShares > 0
                ? `${target.activeShares === 1 ? 'The active link' : `The ${target.activeShares} active links`} of “${target.name}” stay${target.activeShares === 1 ? 's' : ''} the same and show${target.activeShares === 1 ? 's' : ''} the added items once they are processed. People who already downloaded it in a torrent app can download the .torrent again into the same folder to fetch only what is new.`
                : ''}
            </p>
            {error && (
              <p class="form-error" role="alert">
                {error}
              </p>
            )}
            <div class="actions">
              <button type="button" class="btn" onClick={props.onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" class="btn btn-primary" disabled={busy || picked.length === 0}>
                {busy ? 'Working…' : picked.length > 0 ? `Add ${plural(picked.length, 'item')}` : 'Add'}
              </button>
            </div>
          </form>
        )
      )}
    </Modal>
  );
}
