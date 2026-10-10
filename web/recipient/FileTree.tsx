import { useState } from 'preact/hooks';
import type { FileEntry } from '../../src/types.ts';
import type { FileProgress } from './engine.ts';
import { formatBytes, formatPercent } from './format.ts';
import type { FileSaveState } from './save.ts';
import { type TreeNode, checkState, countFiles } from './tree.ts';

export interface FileTreeProps {
  root: TreeNode;
  files: FileEntry[];
  selected: ReadonlySet<number>;
  onToggle: (node: TreeNode) => void;
  locked: boolean;
  /** Present once the download has started. */
  progress: FileProgress[] | null;
  saveStates: Partial<Record<number, FileSaveState>>;
  /** Returns a same-origin URL to save a finished file (service-worker mode), or null. */
  saveUrl: (index: number) => string | null;
}

export function FileTree(props: FileTreeProps) {
  const many = props.files.length > 200;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    const s = new Set<string>();
    if (many) for (const c of props.root.children) if (c.fileIndex === undefined) s.add(c.path);
    return s;
  });
  const toggleCollapse = (path: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  return (
    <ul class="tree" aria-label="Files">
      {props.root.children.map((n) => (
        <Node key={n.path} node={n} depth={0} {...props} collapsed={collapsed} toggleCollapse={toggleCollapse} />
      ))}
    </ul>
  );
}

interface NodeProps extends FileTreeProps {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  toggleCollapse: (path: string) => void;
}

function Node(p: NodeProps) {
  const { node } = p;
  const state = checkState(node, p.selected);
  const isFile = node.fileIndex !== undefined;
  const open = !p.collapsed.has(node.path);

  const checkbox = (
    <input
      type="checkbox"
      class="check"
      checked={state === 'all'}
      indeterminate={state === 'some'}
      disabled={p.locked}
      aria-label={isFile ? node.path : `Folder ${node.path}`}
      onChange={() => p.onToggle(node)}
    />
  );

  if (!isFile) {
    return (
      <li class="node folder">
        <div class="row">
          <button
            type="button"
            class="disclosure"
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${node.name}`}
            onClick={() => p.toggleCollapse(node.path)}
          >
            <span class={open ? 'chev open' : 'chev'} aria-hidden="true" />
          </button>
          <label class="name">
            {checkbox}
            <span class="icon folder-icon" aria-hidden="true" />
            <span class="label">{node.name}</span>
          </label>
          <span class="meta">
            {countFiles(node)} {countFiles(node) === 1 ? 'file' : 'files'} · {formatBytes(node.size)}
          </span>
        </div>
        {open && (
          <ul class="children">
            {node.children.map((c) => (
              <Node key={c.path} {...p} node={c} depth={p.depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const idx = node.fileIndex as number;
  const prog = p.progress?.[idx];
  const isSelected = p.selected.has(idx);
  const save = p.saveStates[idx];
  const url = prog?.done && isSelected ? p.saveUrl(idx) : null;
  const fraction = node.size > 0 ? (prog?.downloaded ?? 0) / node.size : prog?.done ? 1 : 0;

  return (
    <li class={isSelected ? 'node file' : 'node file unselected'}>
      <div class="row">
        <span class="disclosure-spacer" aria-hidden="true" />
        <label class="name">
          {checkbox}
          <span class="icon file-icon" aria-hidden="true" />
          <span class="label">{node.name}</span>
        </label>
        <span class="meta">{formatBytes(node.size)}</span>
        {p.progress && isSelected && (
          <span class="file-status">
            <progress class="bar small" max={1} value={prog?.done ? 1 : fraction} aria-label={`${node.path} progress`} />
            <span class="pct">{prog?.done ? 'Done' : formatPercent(fraction)}</span>
            {save === 'writing' && <span class="tag">Saving…</span>}
            {save === 'saved' && <span class="tag ok">Saved</span>}
            {save === 'error' && <span class="tag bad">Couldn't save</span>}
            {url && (
              <a class="btn small" href={url} download={node.name} aria-label={`Save ${node.path}`}>
                Save
              </a>
            )}
          </span>
        )}
      </div>
    </li>
  );
}
