// Obrazovka zoznamu: položky podľa oddelení, sekcia „V košíku“, pridávanie dole pri palci.
// Ťuk = odškrtnúť, potiahnutie doľava = zmazať (toast Späť), podržanie / ceruzka = úprava.
import * as store from '../store.js';
import { categoryOf } from '../categories.js';
import { suggest, topItems } from '../history.js';
import { icon, toast, undoToast, keepFocus } from '../ui.js';
import { escapeHtml, normalize, parseQuickInput, haptic, plural } from '../util.js';
import { openListSettings } from './list-form.js';
import { openItemEditor } from './item-editor.js';

const LONG_PRESS_MS = 480;
const SWIPE_START_PX = 12;

export function mountList(root, ctx, listId) {
  root.innerHTML = `
    <header class="topbar">
      <button type="button" class="icon-btn" data-act="back" aria-label="Späť na zoznamy">${icon('back')}</button>
      <div class="topbar-title">
        <h1 class="title" id="lt-name"></h1>
        <div class="subtitle" id="lt-sub"></div>
      </div>
      <div class="topbar-actions">
        <span data-slot="sync"></span>
        <button type="button" class="icon-btn" data-act="settings" aria-label="Nastavenia zoznamu">${icon('more')}</button>
      </div>
    </header>
    <main class="scroll" id="items" aria-live="polite"></main>
    <div class="dock">
      <div class="suggest" id="suggest" role="listbox" aria-label="Návrhy" hidden></div>
      <div class="chips" id="chips" aria-label="Časté položky"></div>
      <form class="add-form" id="add-form" autocomplete="off">
        <input id="add-input" class="add-input" type="text" placeholder="Pridať položku…" enterkeyhint="enter"
          autocomplete="off" autocorrect="off" autocapitalize="sentences" spellcheck="false" maxlength="80"
          aria-label="Nová položka" aria-autocomplete="list" aria-controls="suggest">
        <button class="add-btn" type="submit" aria-label="Pridať">${icon('plus')}</button>
      </form>
    </div>`;

  root.querySelector('[data-slot=sync]').replaceWith(ctx.syncPill);
  const $ = sel => root.querySelector(sel);
  const itemsEl = $('#items');
  const input = $('#add-input');
  const form = $('#add-form');
  const suggestEl = $('#suggest');
  const chipsEl = $('#chips');

  let suggestions = [];
  let active = -1;
  let flashId = null;
  let gesture = null;
  let renderPending = false;

  $('[data-act=back]').addEventListener('click', () => ctx.back());
  $('[data-act=settings]').addEventListener('click', () => openListSettings(listId, { onDeleted: () => ctx.navigate('#/', { replace: true }) }));
  keepFocus($('.add-btn'));
  keepFocus(suggestEl);
  keepFocus(chipsEl);

  /* ------------------------------------------------------------ RENDER */

  function openKeys() {
    return new Set(store.itemsOf(listId).filter(i => !i.checked).map(i => normalize(i.name)));
  }

  function render() {
    if (gesture) {
      renderPending = true;
      return;
    }
    renderPending = false;
    const list = store.getList(listId);
    if (!list) {
      toast('Tento zoznam už neexistuje alebo k nemu nemáš prístup.', { type: 'error' });
      ctx.navigate('#/', { replace: true });
      return;
    }
    $('#lt-name').textContent = list.name;
    const items = store.itemsOf(listId);
    const open = items.filter(i => !i.checked);
    const done = items.filter(i => i.checked).sort((a, b) => b.checkedAt - a.checkedAt);
    $('#lt-sub').innerHTML = `${icon(list.shared ? 'users' : 'lock', 'icon-xs')} ${list.shared ? 'Zdieľaný' : 'Súkromný'} · ${open.length} ${plural(open.length, ['položka', 'položky', 'položiek'])}`;

    let html = '';
    if (!items.length) {
      html = `<div class="state">
          <div class="state-emoji" aria-hidden="true">📝</div>
          <p class="state-title">Zoznam je prázdny</p>
          <p class="state-text">Napíš dole, čo treba kúpiť, a stlač Enter. Častú položku pridáš jedným ťuknutím na čip.</p>
        </div>`;
    } else {
      const groups = new Map();
      for (const it of open) {
        if (!groups.has(it.category)) groups.set(it.category, []);
        groups.get(it.category).push(it);
      }
      for (const key of store.categoryOrder()) {
        const g = groups.get(key);
        if (!g) continue;
        const c = categoryOf(key);
        g.sort((a, b) => a.order - b.order);
        html += `<section class="group">
            <h2 class="group-title"><span aria-hidden="true">${c.emoji}</span> ${escapeHtml(c.label)}<span class="group-count">${g.length}</span></h2>
            ${g.map(itemRow).join('')}
          </section>`;
      }
      if (!open.length) {
        html += `<div class="state state-compact"><div class="state-emoji" aria-hidden="true">🎉</div><p class="state-title">Všetko je v košíku</p></div>`;
      }
      if (done.length) {
        html += `<section class="group group-done">
            <div class="group-title group-title-done">
              <span>V košíku <span class="group-count">${done.length}</span></span>
              <button type="button" class="link-btn link-danger" data-act="clear">Vymazať odškrtnuté</button>
            </div>
            ${done.map(itemRow).join('')}
          </section>`;
      }
    }
    itemsEl.innerHTML = html;

    if (flashId) {
      const row = itemsEl.querySelector(`[data-id="${CSS.escape(flashId)}"]`);
      if (row) {
        row.classList.add('flash');
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
      flashId = null;
    }
    renderChips();
    if (input.value.trim()) renderSuggest();
  }

  function itemRow(it) {
    const meta = [it.note].filter(Boolean).map(escapeHtml).join(' · ');
    return `
      <div class="item-row${it.checked ? ' is-checked' : ''}" data-id="${escapeHtml(it.id)}">
        <div class="item-swipe-bg" aria-hidden="true">${icon('trash')}<span>Zmazať</span></div>
        <div class="item-content" role="checkbox" tabindex="0" aria-checked="${it.checked}">
          <span class="check" aria-hidden="true">${icon('check')}</span>
          <span class="item-main">
            <span class="item-name">${escapeHtml(it.name)}</span>
            ${meta ? `<span class="item-note">${meta}</span>` : ''}
          </span>
          ${it.qty ? `<span class="item-qty">${escapeHtml(it.qty)}</span>` : ''}
          <button type="button" class="item-edit" data-act="edit" aria-label="Upraviť ${escapeHtml(it.name)}">${icon('pencil')}</button>
        </div>
      </div>`;
  }

  function renderChips() {
    const merged = store.mergedHistory();
    const chips = topItems(merged, { exclude: openKeys(), limit: 14 });
    chipsEl.innerHTML = chips.length
      ? chips.map(h => `<button type="button" class="chip" data-key="${escapeHtml(h.key)}"><span aria-hidden="true">${categoryOf(h.category).emoji}</span>${escapeHtml(h.displayName)}</button>`).join('')
      : merged.size ? '' : `<span class="chips-hint">Tu sa objavia položky, ktoré kupuješ najčastejšie.</span>`;
    chipsEl.hidden = !!input.value.trim() || !chipsEl.innerHTML;
  }

  function renderSuggest() {
    const q = input.value.trim();
    suggestions = q ? suggest(q, store.mergedHistory(), { exclude: openKeys(), limit: 5 }) : [];
    if (active >= suggestions.length) active = -1;
    chipsEl.hidden = !!q || !chipsEl.innerHTML;
    if (!suggestions.length) {
      suggestEl.hidden = true;
      suggestEl.innerHTML = '';
      input.removeAttribute('aria-activedescendant');
      return;
    }
    suggestEl.hidden = false;
    suggestEl.innerHTML = suggestions.map((h, i) => {
      const meta = [h.lastQty, h.lastNote].filter(Boolean).map(escapeHtml).join(' · ');
      return `<button type="button" class="suggest-row${i === active ? ' is-active' : ''}" role="option" id="sg-${i}" data-i="${i}" aria-selected="${i === active}">
          <span class="suggest-emoji" aria-hidden="true">${categoryOf(h.category).emoji}</span>
          <span class="suggest-name">${escapeHtml(h.displayName)}</span>
          ${meta ? `<span class="suggest-meta">${meta}</span>` : ''}
        </button>`;
    }).join('');
    if (active >= 0) input.setAttribute('aria-activedescendant', `sg-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  /* ------------------------------------------------------------ ADD */

  async function add(entry) {
    const res = await store.addItem(listId, entry);
    if (res.status === 'exists') {
      toast(`„${res.item.name}“ už v zozname je.`);
      flashId = res.item.id;
      render();
    } else if (res.status === 'restored') {
      toast(`„${res.item.name}“ je späť v zozname.`);
      flashId = res.item.id;
    } else if (res.status === 'added') {
      flashId = res.item.id;
    }
    input.value = '';
    active = -1;
    renderSuggest();
  }

  function addFromText(text) {
    const t = text.trim();
    if (!t) return;
    // Presná zhoda s históriou má prednosť pred rozpoznaním množstva („7 days“ ostane názvom).
    const h = store.mergedHistory().get(normalize(t));
    if (h) return add({ name: h.displayName });
    return add(parseQuickInput(t));
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    if (active >= 0 && suggestions[active]) add({ name: suggestions[active].displayName });
    else addFromText(input.value);
    input.focus();
  });

  input.addEventListener('input', () => {
    active = -1;
    renderSuggest();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault();
      active = (active + 1) % suggestions.length;
      renderSuggest();
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault();
      active = active <= 0 ? suggestions.length - 1 : active - 1;
      renderSuggest();
    } else if (e.key === 'Escape') {
      input.value = '';
      active = -1;
      renderSuggest();
    }
  });

  suggestEl.addEventListener('click', e => {
    const row = e.target.closest('[data-i]');
    if (row) add({ name: suggestions[Number(row.dataset.i)].displayName });
  });

  chipsEl.addEventListener('click', e => {
    const chip = e.target.closest('[data-key]');
    if (!chip) return;
    const h = store.mergedHistory().get(chip.dataset.key);
    if (h) {
      haptic(8);
      add({ name: h.displayName });
    }
  });

  /* ------------------------------------------------------------ GESTURES */

  function toggle(id) {
    const it = store.state.items.get(id);
    if (!it) return;
    haptic(it.checked ? 6 : 14);
    store.toggleItem(id);
  }

  async function remove(id) {
    const it = store.state.items.get(id);
    const undo = await store.deleteItem(id);
    undoToast(`Zmazané: ${it ? it.name : 'položka'}`, undo);
  }

  itemsEl.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]');
    if (act?.dataset.act === 'edit') {
      openItemEditor(act.closest('[data-id]').dataset.id);
    } else if (act?.dataset.act === 'clear') {
      const undo = await store.clearChecked(listId);
      undoToast('Odškrtnuté položky sú vymazané.', undo);
    }
  });

  itemsEl.addEventListener('keydown', e => {
    const content = e.target.closest('.item-content');
    if (!content || e.target !== content) return;
    const id = content.closest('[data-id]').dataset.id;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggle(id);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove(id);
    }
  });

  itemsEl.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.item-edit')) return;
    const content = e.target.closest('.item-content');
    if (!content) return;
    const row = content.closest('.item-row');
    gesture = {
      row, content,
      id: row.dataset.id,
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      dx: 0,
      mode: 'pending',
      timer: setTimeout(() => {
        if (gesture && gesture.mode === 'pending') {
          gesture.mode = 'long';
          row.classList.add('is-pressed');
          haptic(20);
        }
      }, LONG_PRESS_MS)
    };
  });

  itemsEl.addEventListener('pointermove', e => {
    const g = gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    const dx = e.clientX - g.x0;
    const dy = e.clientY - g.y0;
    if (g.mode === 'pending' || g.mode === 'long') {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return endGesture(true);
      if (dx < -SWIPE_START_PX && Math.abs(dx) > Math.abs(dy) * 1.2) {
        clearTimeout(g.timer);
        g.mode = 'swipe';
        g.row.classList.remove('is-pressed');
        g.row.classList.add('is-swiping');
        try { g.content.setPointerCapture(e.pointerId); } catch (_) { /* nevadí */ }
      } else if (Math.abs(dx) > 10 && g.mode === 'pending') {
        clearTimeout(g.timer);
      }
    }
    if (g.mode === 'swipe') {
      g.dx = Math.min(0, dx);
      g.content.style.transform = `translateX(${g.dx}px)`;
      g.row.classList.toggle('will-delete', g.dx < -threshold(g.row));
    }
  });

  const threshold = row => Math.min(140, row.offsetWidth * 0.35);

  function endGesture(cancelled) {
    const g = gesture;
    if (!g) return;
    clearTimeout(g.timer);
    gesture = null;
    g.row.classList.remove('is-pressed');
    if (!cancelled) {
      if (g.mode === 'pending') toggle(g.id);
      else if (g.mode === 'long') openItemEditor(g.id);
      else if (g.mode === 'swipe') {
        if (g.dx < -threshold(g.row)) {
          g.content.style.transition = 'transform .18s ease-out';
          g.content.style.transform = 'translateX(-110%)';
          haptic(18);
          setTimeout(() => remove(g.id), 160);
          return;
        }
      }
    }
    g.content.style.transition = 'transform .2s ease';
    g.content.style.transform = '';
    g.row.classList.remove('is-swiping', 'will-delete');
    setTimeout(() => {
      g.content.style.transition = '';
      if (renderPending) render();
    }, 200);
  }

  itemsEl.addEventListener('pointerup', e => {
    if (gesture && e.pointerId === gesture.pointerId) endGesture(false);
  });
  itemsEl.addEventListener('pointercancel', () => endGesture(true));
  itemsEl.addEventListener('contextmenu', e => {
    if (e.target.closest('.item-content')) e.preventDefault();
  });

  render();
  return {
    update: render,
    destroy() {
      gesture = null;
    }
  };
}
