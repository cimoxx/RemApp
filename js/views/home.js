// Domovská obrazovka: prehľad zoznamov.
import * as store from '../store.js';
import { icon } from '../ui.js';
import { escapeHtml, plural } from '../util.js';
import { openListForm } from './list-form.js';

export function mountHome(root, ctx) {
  let reorder = false;

  root.innerHTML = `
    <header class="topbar">
      <div class="brand">
        <span class="brand-icon">${icon('cart')}</span>
        <div class="brand-text">
          <h1 class="brand-name">RemApp</h1>
          <div class="brand-sub">Nákupné zoznamy</div>
        </div>
      </div>
      <div class="topbar-actions">
        <span data-slot="sync"></span>
        <a class="icon-btn" href="#/settings" aria-label="Nastavenia">${icon('settings')}</a>
      </div>
    </header>
    <main class="scroll" id="home-main"></main>
    <div class="dock dock-home">
      <button type="button" class="btn btn-primary btn-block" data-act="new">${icon('plus')}<span>Nový zoznam</span></button>
    </div>`;

  const main = root.querySelector('#home-main');
  root.querySelector('[data-slot=sync]').replaceWith(ctx.syncPill);
  root.querySelector('[data-act=new]').addEventListener('click', () => openListForm({ onCreated: l => ctx.navigate(`#/list/${l.id}`) }));

  main.addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('[data-id]')?.dataset.id;
    if (btn.dataset.act === 'open' && !reorder) ctx.navigate(`#/list/${id}`);
    if (btn.dataset.act === 'reorder') {
      reorder = !reorder;
      render();
    }
    if (btn.dataset.act === 'up') store.moveList(id, -1);
    if (btn.dataset.act === 'down') store.moveList(id, 1);
  });

  function render() {
    const lists = store.sortedLists();
    if (!lists.length) {
      main.innerHTML = ctx.isLoading()
        ? `<div class="state"><div class="spinner" aria-hidden="true"></div><p class="state-title">Načítavam zoznamy…</p></div>`
        : `<div class="state">
             <div class="state-emoji" aria-hidden="true">🛒</div>
             <p class="state-title">Zatiaľ nemáš žiadny zoznam</p>
             <p class="state-text">Vytvor prvý – napríklad <b>Lidl</b>, <b>Drogéria</b> alebo <b>Chata</b>. Zdieľaný zoznam uvidí aj partner, súkromný iba ty.</p>
           </div>`;
      return;
    }
    main.innerHTML = `
      <div class="section-head">
        <h2 class="section-title">Zoznamy</h2>
        ${lists.length > 1 ? `<button type="button" class="link-btn" data-act="reorder">${reorder ? 'Hotovo' : `${icon('sort')} Zoradiť`}</button>` : ''}
      </div>
      <div class="cards">
        ${lists.map((l, i) => card(l, i, lists.length)).join('')}
      </div>`;
  }

  function card(l, i, n) {
    const pending = store.pendingCount(l.id);
    const total = store.itemsOf(l.id).length;
    const mine = store.isOwner(l);
    const kind = l.shared ? (mine ? 'Zdieľaný' : 'Zdieľaný partnerom') : 'Súkromný';
    const meta = total === 0 ? 'prázdny' : pending === 0 ? 'všetko kúpené' : `${pending} ${plural(pending, ['položka', 'položky', 'položiek'])} na kúpu`;
    return `
      <div class="list-card${reorder ? ' is-reorder' : ''}" data-id="${escapeHtml(l.id)}">
        <button type="button" class="list-card-main" data-act="open" ${reorder ? 'tabindex="-1"' : ''}>
          <span class="list-kind ${l.shared ? 'is-shared' : 'is-private'}" title="${kind}">${icon(l.shared ? 'users' : 'lock')}</span>
          <span class="list-text">
            <span class="list-name">${escapeHtml(l.name)}</span>
            <span class="list-meta">${kind} · ${meta}</span>
          </span>
          ${reorder ? '' : `<span class="count-badge${pending ? '' : ' is-zero'}" aria-label="${pending} nevybavených">${pending || icon('check')}</span>`}
        </button>
        ${reorder ? `
          <div class="reorder-btns">
            <button type="button" class="icon-btn" data-act="up" aria-label="Posunúť vyššie" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
            <button type="button" class="icon-btn" data-act="down" aria-label="Posunúť nižšie" ${i === n - 1 ? 'disabled' : ''}>${icon('down')}</button>
          </div>` : ''}
      </div>`;
  }

  render();
  return { update: render, destroy() {} };
}
