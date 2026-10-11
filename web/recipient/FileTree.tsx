import { useState } from 'preact/hooks';
import type { FileEntry } from '../../src/types.ts';
import type { FileProgress } from './engine.ts';
import { formatBytes, formatPercent } from './format.ts';
import { ChevronIcon, FileIcon, FolderIcon } from './icons.tsx';
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
    const n = countFiles(node);
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
            <ChevronIcon open={open} />
          </button>
          <label class="name">
            {checkbox}
            <FolderIcon />
            <span class="label">{node.name}</span>
            <span class="count">
              {n} {n === 1 ? 'file' : 'files'}
            </span>
          </label>
          <span class="size">{formatBytes(node.size)}</span>
          {p.progress && <span class="file-status" aria-hidden="true" />}
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
  const isSelected = p.selected.has(idx);

  return (
    <li class={isSelected ? 'node file' : 'node file unselected'}>
      <div class="row">
        <span class="disclosure" aria-hidden="true" />
        <label class="name">
          {checkbox}
          <FileIcon />
          <span class="label">{node.name}</span>
        </label>
        <span class="size">{formatBytes(node.size)}</span>
        {p.progress && isSelected && <FileStatus {...p} idx={idx} />}
      </div>
    </li>
  );
}

/** One status per file: progress while downloading, then the save state or a Save link. */
function FileStatus(p: NodeProps & { idx: number }) {
  const prog = p.progress?.[p.idx];
  const save = p.saveStates[p.idx];
  const url = prog?.done ? p.saveUrl(p.idx) : null;
  const fraction = p.node.size > 0 ? (prog?.downloaded ?? 0) / p.node.size : prog?.done ? 1 : 0;

  let content;
  if (save === 'error') content = <span class="tag bad">Couldn't save</span>;
  else if (save === 'saved') content = <span class="tag ok">Saved</span>;
  else if (url)
    content = (
      <a class="btn small" href={url} download={p.node.name} aria-label={`Save ${p.node.path}`}>
        Save
      </a>
    );
  else if (!prog?.done)
    content = (
      <>
        <progress class="bar small" max={1} value={fraction} aria-label={`${p.node.path} progress`} />
        <span class="pct">{formatPercent(fraction)}</span>
      </>
    );
  else if (save === 'writing') content = <span class="tag">Saving…</span>;
  else content = <span class="tag">Done</span>;
  return <span class="file-status">{content}</span>;
}
