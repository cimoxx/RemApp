// Nastavenia: účet, synchronizácia, poradie oddelení, história položiek, verzia a changelog.
import * as store from '../store.js';
import * as sync from '../sync.js';
import { categoryOf, DEFAULT_ORDER } from '../categories.js';
import { CHANGELOG } from '../changelog.js';
import { icon, toast, confirmDialog } from '../ui.js';
import { escapeHtml, normalize, relativeTime } from '../util.js';

const STATUS_TEXT = {
  ok: 'Všetko je synchronizované.',
  syncing: 'Synchronizujem…',
  pending: 'Čakajú neodoslané zmeny.',
  offline: 'Si offline. Zmeny sa uložili a odošlú sa po pripojení.',
  error: 'Synchronizácia zlyhala.',
  idle: 'Synchronizácia sa ešte nespustila.'
};

export function mountSettings(root, ctx) {
  let historyQuery = '';

  root.innerHTML = `
    <header class="topbar">
      <button type="button" class="icon-btn" data-act="back" aria-label="Späť">${icon('back')}</button>
      <div class="topbar-title"><h1 class="title">Nastavenia</h1></div>
      <div class="topbar-actions"><span data-slot="sync"></span></div>
    </header>
    <main class="scroll settings">
      <section class="card">
        <h2 class="card-title">Účet</h2>
        <div class="account">
          <div class="avatar" aria-hidden="true">${escapeHtml((ctx.session.name || ctx.session.email)[0].toUpperCase())}</div>
          <div class="account-text">
            <div class="account-name">${escapeHtml(ctx.session.name || 'Prihlásený')}</div>
            <div class="account-email">${escapeHtml(ctx.session.email)}</div>
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-block" data-act="logout">${icon('logout')}<span>Odhlásiť sa</span></button>
      </section>

      <section class="card">
        <h2 class="card-title">Synchronizácia</h2>
        <div id="sync-info" class="sync-info"></div>
        <div class="btn-row">
          <button type="button" class="btn btn-ghost" data-act="sync">${icon('refresh')}<span>Synchronizovať</span></button>
          <button type="button" class="btn btn-ghost" data-act="resync">Stiahnuť všetko znova</button>
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          <h2 class="card-title">Poradie oddelení</h2>
          <button type="button" class="link-btn" data-act="cat-reset">Predvolené</button>
        </div>
        <p class="card-help">Zoraď oddelenia tak, ako prechádzaš obchodom. Poradie je iba tvoje.</p>
        <ol class="order-list" id="cat-order"></ol>
      </section>

      <section class="card">
        <h2 class="card-title">História položiek</h2>
        <p class="card-help">Z histórie sa berú návrhy a rýchle čipy. Položky zo súkromných zoznamov vidíš iba ty.</p>
        <label class="search">
          ${icon('search')}
          <input class="input" type="search" id="hist-q" placeholder="Hľadať v histórii" autocomplete="off" aria-label="Hľadať v histórii">
        </label>
        <ul class="hist-list" id="hist-list"></ul>
      </section>

      <section class="card">
        <h2 class="card-title">O aplikácii</h2>
        <p class="about">RemApp <b>v${escapeHtml(self.APP_VERSION)}</b> · nákupné zoznamy z rodiny Flow</p>
        <div class="changelog">
          ${CHANGELOG.map(v => `
            <div class="cl-version">
              <div class="cl-head"><b>v${escapeHtml(v.version)}</b><span>${escapeHtml(new Date(v.date).toLocaleDateString('sk-SK'))}</span></div>
              <ul>${v.changes.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
            </div>`).join('')}
        </div>
      </section>
    </main>`;

  root.querySelector('[data-slot=sync]').replaceWith(ctx.syncPill);
  const $ = s => root.querySelector(s);

  $('[data-act=back]').addEventListener('click', () => ctx.back());
  $('[data-act=logout]').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Odhlásiť sa?',
      text: 'Z tohto zariadenia sa vymažú uložené zoznamy. Neodoslané zmeny sa stratia.',
      confirmLabel: 'Odhlásiť',
      danger: true
    });
    if (ok) ctx.logout();
  });
  $('[data-act=sync]').addEventListener('click', () => sync.syncNow());
  $('[data-act=resync]').addEventListener('click', async () => {
    await sync.resyncAll();
    toast('Dáta sú stiahnuté znova.', { type: 'success' });
  });

  $('[data-act=cat-reset]').addEventListener('click', () => store.setPref('categoryOrder', DEFAULT_ORDER));
  $('#cat-order').addEventListener('click', e => {
    const b = e.target.closest('[data-move]');
    if (!b) return;
    const order = store.categoryOrder();
    const i = order.indexOf(b.closest('[data-key]').dataset.key);
    const j = i + Number(b.dataset.move);
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    store.setPref('categoryOrder', order);
  });

  $('#hist-q').addEventListener('input', e => {
    historyQuery = e.target.value;
    renderHistory();
  });
  $('#hist-list').addEventListener('click', e => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    const h = store.mergedHistory().get(b.dataset.del);
    store.deleteHistory(b.dataset.del);
    toast(`Odstránené z histórie: ${h ? h.displayName : 'položka'}`);
  });

  function renderSync(s = sync.getStatus()) {
    const el = $('#sync-info');
    if (!el) return;
    el.innerHTML = `
      <div class="sync-line" data-state="${s.state}"><span class="dot"></span>${escapeHtml(STATUS_TEXT[s.state] || '')}</div>
      ${s.message ? `<div class="sync-msg">${escapeHtml(s.message)}</div>` : ''}
      <div class="sync-meta">Posledná úspešná synchronizácia: ${escapeHtml(relativeTime(s.lastOkAt))}${s.pending ? ` · neodoslané: ${s.pending}` : ''}</div>`;
  }

  function renderOrder() {
    const order = store.categoryOrder();
    $('#cat-order').innerHTML = order.map((k, i) => {
      const c = categoryOf(k);
      return `<li class="order-row" data-key="${k}">
          <span class="order-label"><span aria-hidden="true">${c.emoji}</span> ${escapeHtml(c.label)}</span>
          <button type="button" class="icon-btn" data-move="-1" aria-label="${escapeHtml(c.label)} vyššie" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
          <button type="button" class="icon-btn" data-move="1" aria-label="${escapeHtml(c.label)} nižšie" ${i === order.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
        </li>`;
    }).join('');
  }

  function renderHistory() {
    const q = normalize(historyQuery);
    const all = [...store.mergedHistory().values()]
      .filter(h => !q || h.key.includes(q))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const shown = all.slice(0, 150);
    $('#hist-list').innerHTML = shown.length
      ? shown.map(h => {
        const shared = h.sources.some(s => s.owner === store.SHARED);
        return `<li class="hist-row">
            <span class="hist-text">
              <span class="hist-name">${escapeHtml(h.displayName)}</span>
              <span class="hist-meta">${h.count}× · ${shared ? 'spoločná' : 'súkromná'}${h.lastQty ? ' · ' + escapeHtml(h.lastQty) : ''}</span>
            </span>
            <button type="button" class="icon-btn" data-del="${escapeHtml(h.key)}" aria-label="Odstrániť ${escapeHtml(h.displayName)} z histórie">${icon('trash')}</button>
          </li>`;
      }).join('') + (all.length > shown.length ? `<li class="hist-more">…a ďalších ${all.length - shown.length}. Spresni hľadanie.</li>` : '')
      : `<li class="hist-empty">${q ? 'Nič sa nenašlo.' : 'História je zatiaľ prázdna. Naplní sa, keď začneš pridávať položky.'}</li>`;
  }

  const offStatus = sync.onStatus(renderSync);
  const update = () => {
    renderOrder();
    renderHistory();
  };
  update();
  return {
    update,
    destroy() {
      offStatus();
    }
  };
}
