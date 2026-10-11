// Inline SVG icons (stroke = currentColor; sized in CSS). Inline markup, so the CSP needs nothing extra.
const base = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.5,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
} as const;

export function FolderIcon() {
  return (
    <svg class="icon" {...base}>
      <path d="M1.75 4.25c0-.69.56-1.25 1.25-1.25h3l1.5 1.75H13c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25H3c-.69 0-1.25-.56-1.25-1.25z" />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg class="icon" {...base}>
      <path d="M9 1.75H4.25c-.69 0-1.25.56-1.25 1.25v10c0 .69.56 1.25 1.25 1.25h7.5c.69 0 1.25-.56 1.25-1.25V5.75z" />
      <path d="M9 1.75v4h4" />
    </svg>
  );
}

export function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg class={open ? 'chev open' : 'chev'} {...base}>
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

export function Logo() {
  return (
    <svg class="logo" viewBox="0 0 20 20" aria-hidden="true">
      <rect width="20" height="20" rx="5" class="logo-bg" />
      <path d="M10 5.5v8M6.5 10l3.5 3.5 3.5-3.5" class="logo-fg" />
    </svg>
  );
}
