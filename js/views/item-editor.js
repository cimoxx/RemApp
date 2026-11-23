// Úprava položky: názov, množstvo, poznámka, oddelenie.
import * as store from '../store.js';
import { CATEGORIES } from '../categories.js';
import { openSheet, undoToast, icon } from '../ui.js';
import { escapeHtml } from '../util.js';

const QTY_PRESETS = ['1 ks', '2 ks', '3 ks', '6 ks', '500 g', '1 kg', '1 l', '1 bal'];

export function openItemEditor(itemId) {
  const it = store.state.items.get(itemId);
  if (!it || it.deleted) return;
  const order = store.categoryOrder();
  const cats = order.map(k => CATEGORIES.find(c => c.key === k));

  const s = openSheet({
    title: 'Upraviť položku',
    content: `
      <form class="form" data-form>
        <label class="field">
          <span class="field-label">Názov</span>
          <input class="input" name="name" maxlength="80" value="${escapeHtml(it.name)}" required autocomplete="off">
        </label>
        <label class="field">
          <span class="field-label">Množstvo</span>
          <input class="input" name="qty" maxlength="24" value="${escapeHtml(it.qty)}" placeholder="napr. 2 ks, 1 kg" autocomplete="off">
        </label>
        <div class="preset-row" role="group" aria-label="Rýchle množstvo">
          ${QTY_PRESETS.map(q => `<button type="button" class="chip chip-sm${q === it.qty ? ' is-on' : ''}" data-qty="${q}">${q}</button>`).join('')}
        </div>
        <label class="field">
          <span class="field-label">Poznámka</span>
          <input class="input" name="note" maxlength="140" value="${escapeHtml(it.note)}" placeholder="napr. bez laktózy" autocomplete="off">
        </label>
        <fieldset class="field">
          <legend class="field-label">Oddelenie</legend>
          <div class="cat-grid">
            ${cats.map(c => `
              <label class="cat-opt">
                <input type="radio" name="category" value="${c.key}" ${c.key === it.category ? 'checked' : ''}>
                <span><span aria-hidden="true">${c.emoji}</span> ${escapeHtml(c.label)}</span>
              </label>`).join('')}
          </div>
        </fieldset>
        <button type="submit" class="btn btn-primary btn-block">Uložiť</button>
        <button type="button" class="btn btn-danger-ghost btn-block" data-act="delete">${icon('trash')}<span>Zmazať položku</span></button>
      </form>`
  });

  const form = s.root.querySelector('[data-form]');
  s.root.querySelector('.preset-row').addEventListener('click', e => {
    const b = e.target.closest('[data-qty]');
    if (!b) return;
    form.qty.value = b.dataset.qty;
    s.root.querySelectorAll('[data-qty]').forEach(x => x.classList.toggle('is-on', x === b));
  });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    await store.updateItem(itemId, {
      name: form.name.value.trim() || it.name,
      qty: form.qty.value.trim(),
      note: form.note.value.trim(),
      category: form.category.value || it.category
    });
    s.close();
  });

  s.root.querySelector('[data-act=delete]').addEventListener('click', async () => {
    const undo = await store.deleteItem(itemId);
    await s.close();
    undoToast(`Zmazané: ${it.name}`, undo);
  });
}
