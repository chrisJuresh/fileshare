// Admin dashboard (Preact). Served behind Cloudflare Access; the app re-verifies the Access JWT.
import '@uppy/core/css/style.min.css';
import '@uppy/dashboard/css/style.min.css';
import './app.css';
import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ItemDto, ShareDto } from '../../src/types.ts';
import { AddItemsDialog, isItemDrag, type AddItemsRequest } from './add-items.tsx';
import { api, errorMessage, setAuthProblemHandler } from './api.ts';
import { Health } from './health.tsx';
import { Library } from './library.tsx';
import { useLive } from './live.ts';
import { Settings } from './settings.tsx';
import { ShareDialog } from './share-dialog.tsx';
import { Shares } from './shares.tsx';
import { ToastProvider } from './ui.tsx';
import { Upload } from './upload.tsx';

const TABS = [
  { id: 'library', label: 'Library' },
  { id: 'shares', label: 'Shares' },
  { id: 'upload', label: 'Upload' },
  { id: 'health', label: 'Stats & health' },
  { id: 'settings', label: 'Settings' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const tabFromHash = (): TabId => {
  const h = location.hash.replace(/^#/, '');
  return (TABS.find((t) => t.id === h)?.id ?? 'library') as TabId;
};

function App() {
  const [tab, setTab] = useState<TabId>(tabFromHash());
  const [items, setItems] = useState<ItemDto[] | null>(null);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareDto[] | null>(null);
  const [sharesError, setSharesError] = useState<string | null>(null);
  const [sharing, setSharing] = useState<ItemDto | null>(null);
  const [addingItems, setAddingItems] = useState<AddItemsRequest | null>(null);
  const [authProblem, setAuthProblem] = useState(false);
  const { msg: live, connected } = useLive();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => setAuthProblemHandler(() => setAuthProblem(true)), []);

  const loadItems = useCallback(async () => {
    try {
      setItems(await api<ItemDto[]>('GET', '/api/admin/items'));
      setItemsError(null);
    } catch (e) {
      setItemsError(errorMessage(e));
    }
  }, []);
  const loadShares = useCallback(async () => {
    try {
      setShares(await api<ShareDto[]>('GET', '/api/admin/shares'));
      setSharesError(null);
    } catch (e) {
      setSharesError(errorMessage(e));
    }
  }, []);
  const reloadAll = useCallback(() => {
    void loadItems();
    void loadShares();
  }, [loadItems, loadShares]);

  useEffect(() => {
    reloadAll();
    const onHash = (): void => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [reloadAll]);

  // Refetch when the live stream shows items appearing, disappearing or changing status.
  const liveSig = live ? live.items.map((i) => `${i.id}:${i.status}`).sort().join(',') : '';
  const lastSig = useRef('');
  useEffect(() => {
    if (!liveSig || liveSig === lastSig.current) return;
    const first = lastSig.current === '';
    lastSig.current = liveSig;
    if (!first) reloadAll();
  }, [liveSig, reloadAll]);

  // Merge live hashing progress into the item list without refetching.
  const shownItems = useMemo(() => {
    if (!items || !live) return items;
    const byId = new Map(live.items.map((i) => [i.id, i]));
    return items.map((it) => {
      const l = byId.get(it.id);
      return l && l.status === it.status ? { ...it, progress: l.progress } : it;
    });
  }, [items, live]);

  const select = (id: TabId): void => {
    setTab(id);
    history.replaceState(null, '', `#${id}`);
  };
  const onTabKey = (e: KeyboardEvent, idx: number): void => {
    let next = -1;
    if (e.key === 'ArrowRight') next = (idx + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const t = TABS[next]!;
    select(t.id);
    tabRefs.current[t.id]?.focus();
  };

  const activeLinks = shares?.filter((s) => s.state === 'active').length ?? 0;

  return (
    <div class="app">
      <header class="topbar">
        <h1 class="brand">fileshare</h1>
        <span class={connected ? 'live-dot live-on' : 'live-dot'} title={connected ? 'Live updates connected' : 'Live updates reconnecting'}>
          <span class="sr-only">{connected ? 'Live updates connected' : 'Live updates disconnected'}</span>
        </span>
      </header>
      {authProblem && (
        <div class="banner" role="alert">
          A request was refused. Your Cloudflare Access session may have expired.{' '}
          <button type="button" class="btn btn-small" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}
      <nav class="tabs" role="tablist" aria-label="Sections">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            class={tab === t.id ? 'tab tab-on' : 'tab'}
            onClick={() => select(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
            // Dragging a library row over Library/Shares opens that tab, so it can be dropped on a share.
            onDragEnter={(e) => {
              if ((t.id === 'library' || t.id === 'shares') && isItemDrag(e) && tab !== t.id) select(t.id);
            }}
          >
            {t.label}
            {t.id === 'shares' && activeLinks > 0 && <span class="tab-count">{activeLinks}</span>}
          </button>
        ))}
      </nav>
      <main>
        {/* All panels stay mounted so an upload keeps running while you look elsewhere. */}
        <section id="panel-library" role="tabpanel" aria-labelledby="tab-library" hidden={tab !== 'library'}>
          <Library items={shownItems} error={itemsError} onChanged={reloadAll} onShare={setSharing} onAddItems={setAddingItems} />
        </section>
        <section id="panel-shares" role="tabpanel" aria-labelledby="tab-shares" hidden={tab !== 'shares'}>
          <Shares
            shares={shares}
            error={sharesError}
            swarms={live?.shares ?? {}}
            items={items}
            onChanged={reloadAll}
            onAddItems={setAddingItems}
          />
        </section>
        <section id="panel-upload" role="tabpanel" aria-labelledby="tab-upload" hidden={tab !== 'upload'}>
          <Upload onItemsChanged={() => void loadItems()} />
        </section>
        <section id="panel-health" role="tabpanel" aria-labelledby="tab-health" hidden={tab !== 'health'}>
          <Health active={tab === 'health'} live={live} />
        </section>
        <section id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden={tab !== 'settings'}>
          <Settings active={tab === 'settings'} live={live} />
        </section>
      </main>
      <ShareDialog item={sharing} onClose={() => setSharing(null)} onCreated={() => reloadAll()} />
      <AddItemsDialog request={addingItems} items={items} onClose={() => setAddingItems(null)} onAdded={reloadAll} />
    </div>
  );
}

render(
  <ToastProvider>
    <App />
  </ToastProvider>,
  document.getElementById('app')!,
);
