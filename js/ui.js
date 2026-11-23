// Spoločné UI prvky: ikony, toast, bottom sheet, potvrdzovací dialóg.
import { escapeHtml } from './util.js';
import { UNDO_MS } from './config.js';

// Obrysové ikony v štýle Lucide (ISC licencia), 24×24.
const PATHS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  settings: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  sort: '<path d="m21 16-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16"/>',
  refresh: '<path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16M16 16h5v5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>'
};

export function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/* ---------------------------------------------------------------- TOAST */

let toastTimer = null;

/**
 * Jeden toast naraz. `action` = { label, fn } (napr. „Späť“), duration v ms.
 */
export function toast(text, { type = 'info', action = null, duration } = {}) {
  const host = document.getElementById('toast-host');
  clearTimeout(toastTimer);
  host.innerHTML = '';
  const node = el(`
    <div class="toast toast-${type}" role="${type === 'error' ? 'alert' : 'status'}">
      <span class="toast-text">${escapeHtml(text)}</span>
      ${action ? `<button type="button" class="toast-action">${escapeHtml(action.label)}</button>` : ''}
    </div>`);
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  const close = () => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 250);
  };
  if (action) {
    node.querySelector('.toast-action').addEventListener('click', () => {
      clearTimeout(toastTimer);
      close();
      action.fn();
    });
  }
  toastTimer = setTimeout(close, duration ?? (action ? UNDO_MS : 2600));
  return close;
}

export const undoToast = (text, undo) => toast(text, { action: { label: 'Späť', fn: undo }, duration: UNDO_MS });

/* ---------------------------------------------------------------- SHEET */

let openSheets = [];

window.addEventListener('popstate', () => {
  // Systémové „späť“ na Androide zatvorí najvrchnejší sheet namiesto odchodu z obrazovky.
  const top = openSheets[openSheets.length - 1];
  if (top) top.close({ fromHistory: true });
});

/**
 * Bottom sheet. `content` je HTML reťazec; vráti { root, close }.
 */
export function openSheet({ title, content, onClose, variant = 'sheet' }) {
  const root = el(`
    <div class="overlay overlay-${variant}">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        ${variant === 'sheet' ? '<div class="sheet-grip" aria-hidden="true"></div>' : ''}
        <div class="sheet-head">
          <h2 class="sheet-title">${escapeHtml(title)}</h2>
          <button type="button" class="icon-btn sheet-close" aria-label="Zavrieť">${icon('x')}</button>
        </div>
        <div class="sheet-body">${content}</div>
      </div>
    </div>`);
  document.body.appendChild(root);
  const prevFocus = document.activeElement;
  requestAnimationFrame(() => root.classList.add('show'));

  let closed = false;
  const sheet = {
    root,
    /** Vráti promise, ktorý sa vyrieši až po návrate v histórii – až potom je bezpečné navigovať. */
    close({ fromHistory = false } = {}) {
      if (closed) return Promise.resolve();
      closed = true;
      openSheets = openSheets.filter(s => s !== sheet);
      root.classList.remove('show');
      root.style.pointerEvents = 'none'; // počas animácie zatvárania už nezachytáva dotyky
      setTimeout(() => root.remove(), 220);
      document.removeEventListener('keydown', onKey);
      if (prevFocus && prevFocus.focus && document.contains(prevFocus) && prevFocus.tagName !== 'INPUT') prevFocus.focus();
      const back = !fromHistory && history.state && history.state.sheet
        ? new Promise(resolve => {
          const done = () => {
            window.removeEventListener('popstate', done);
            clearTimeout(t);
            resolve();
          };
          const t = setTimeout(done, 400);
          window.addEventListener('popstate', done);
          history.back();
        })
        : Promise.resolve();
      return back.then(() => onClose && onClose());
    }
  };
  const onKey = e => {
    if (e.key === 'Escape' && openSheets[openSheets.length - 1] === sheet) sheet.close();
  };
  document.addEventListener('keydown', onKey);
  root.addEventListener('click', e => {
    if (e.target === root) sheet.close();
  });
  root.querySelector('.sheet-close').addEventListener('click', () => sheet.close());
  history.pushState({ sheet: true }, '');
  openSheets.push(sheet);
  return sheet;
}

/** Zavrie všetky sheety bez návratu v histórii (pri zmene obrazovky alebo odhlásení). */
export function closeAllSheets() {
  for (const s of [...openSheets]) s.close({ fromHistory: true });
}

/** Potvrdzovací dialóg; vráti Promise<boolean>. */
export function confirmDialog({ title, text, confirmLabel = 'Potvrdiť', danger = false }) {
  return new Promise(resolve => {
    let answer = false;
    const s = openSheet({
      title,
      variant: 'dialog',
      content: `
        <p class="dialog-text">${escapeHtml(text)}</p>
        <div class="btn-row">
          <button type="button" class="btn btn-ghost" data-act="cancel">Zrušiť</button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(confirmLabel)}</button>
        </div>`,
      onClose: () => resolve(answer)
    });
    s.root.querySelector('[data-act=cancel]').addEventListener('click', () => s.close());
    s.root.querySelector('[data-act=ok]').addEventListener('click', () => {
      answer = true;
      s.close();
    });
    s.root.querySelector('[data-act=ok]').focus();
  });
}

/** Zabráni tomu, aby ťuk na tlačidlo zobral fokus vstupnému poľu (klávesnica ostane otvorená). */
export function keepFocus(node) {
  node.addEventListener('mousedown', e => e.preventDefault());
}
