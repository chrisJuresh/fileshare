// Folder tree built from the flat file list of an UnlockResponse, plus tri-state selection helpers.
import type { FileEntry } from '../../src/types.ts';

export interface TreeNode {
  name: string;
  /** '/'-joined path from the torrent root ('' for the root). */
  path: string;
  /** Set for files (index into UnlockResponse.files). */
  fileIndex?: number;
  children: TreeNode[];
  /** Every file index at or below this node. */
  fileIndices: number[];
  size: number;
}

export function buildTree(files: FileEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: [], fileIndices: [], size: 0 };
  const dirs = new Map<string, TreeNode>([['', root]]);

  files.forEach((f, index) => {
    const parts = f.path.split('/').filter((p) => p.length > 0);
    if (parts.length === 0) return;
    let parent = root;
    let acc = '';
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : (parts[i] as string);
      let dir = dirs.get(acc);
      if (!dir) {
        dir = { name: parts[i] as string, path: acc, children: [], fileIndices: [], size: 0 };
        dirs.set(acc, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    parent.children.push({
      name: parts[parts.length - 1] as string,
      path: parts.join('/'),
      fileIndex: index,
      children: [],
      fileIndices: [index],
      size: f.length,
    });
  });

  const finish = (node: TreeNode): void => {
    for (const c of node.children) finish(c);
    if (node.fileIndex === undefined) {
      node.fileIndices = node.children.flatMap((c) => c.fileIndices);
      node.size = node.children.reduce((s, c) => s + c.size, 0);
      node.children.sort((a, b) => {
        const af = a.fileIndex === undefined ? 0 : 1;
        const bf = b.fileIndex === undefined ? 0 : 1;
        return af - bf || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
    }
  };
  finish(root);
  return root;
}

export type CheckState = 'all' | 'none' | 'some';

export function checkState(node: TreeNode, selected: ReadonlySet<number>): CheckState {
  let on = 0;
  for (const i of node.fileIndices) if (selected.has(i)) on++;
  if (on === 0) return 'none';
  return on === node.fileIndices.length ? 'all' : 'some';
}

/** Ticking a partly/un-ticked folder selects everything below it; ticking a full one clears it. */
export function toggleNode(node: TreeNode, selected: ReadonlySet<number>): Set<number> {
  const next = new Set(selected);
  const select = checkState(node, selected) !== 'all';
  for (const i of node.fileIndices) {
    if (select) next.add(i);
    else next.delete(i);
  }
  return next;
}

export function countFiles(node: TreeNode): number {
  return node.fileIndices.length;
}
