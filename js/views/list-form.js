// Vytvorenie zoznamu a nastavenia existujúceho zoznamu (premenovanie, zdieľanie, zmazanie).
import * as store from '../store.js';
import { openSheet, confirmDialog, toast, undoToast, icon } from '../ui.js';
import { escapeHtml } from '../util.js';

const SHARE_HELP_ON = 'Zoznam aj jeho položky vidí a upravuje aj partner.';
const SHARE_HELP_OFF = 'Súkromný zoznam vidíš iba ty. Partnerovi sa nezobrazí ani jeho názov.';

function shareToggle(checked) {
  return `
    <label class="toggle-row">
      <span class="toggle-text">
        <span class="toggle-label">Zdieľať s partnerom</span>
        <span class="toggle-help" data-help>${checked ? SHARE_HELP_ON : SHARE_HELP_OFF}</span>
      </span>
      <input type="checkbox" class="switch" name="shared" ${checked ? 'checked' : ''}>
    </label>`;
}

function wireHelp(root) {
  const input = root.querySelector('[name=shared]');
  if (!input) return;
  input.addEventListener('change', () => {
    root.querySelector('[data-help]').textContent = input.checked ? SHARE_HELP_ON : SHARE_HELP_OFF;
  });
}

export function openListForm({ onCreated } = {}) {
  const s = openSheet({
    title: 'Nový zoznam',
    content: `
      <form class="form" data-form>
        <label class="field">
          <span class="field-label">Názov</span>
          <input class="input" name="name" maxlength="60" placeholder="napr. Lidl, Drogéria, Chata" required autocomplete="off" enterkeyhint="done">
        </label>
        ${shareToggle(true)}
        <button type="submit" class="btn btn-primary btn-block">Vytvoriť zoznam</button>
      </form>`
  });
  wireHelp(s.root);
  const form = s.root.querySelector('[data-form]');
  form.name.focus();
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const name = form.name.value.trim();
    if (!name) return;
    const list = await store.createList(name, form.shared.checked);
    await s.close();
    onCreated && onCreated(list);
  });
}

export function openListSettings(listId, { onDeleted } = {}) {
  const l = store.getList(listId);
  if (!l) return;
  const owner = store.isOwner(l);
  const hasChecked = store.itemsOf(listId).some(i => i.checked);
  const s = openSheet({
    title: 'Nastavenia zoznamu',
    content: `
      <form class="form" data-form>
        <label class="field">
          <span class="field-label">Názov</span>
          <input class="input" name="name" maxlength="60" value="${escapeHtml(l.name)}" required autocomplete="off" enterkeyhint="done">
        </label>
        ${owner ? shareToggle(l.shared) : `
          <div class="info-row">${icon('users')}<span>Zdieľaný zoznam. Vlastník: <b>${escapeHtml(l.owner)}</b>. Zdieľanie môže vypnúť iba vlastník.</span></div>`}
        <button type="submit" class="btn btn-primary btn-block">Uložiť</button>
      </form>
      <div class="sheet-actions">
        ${hasChecked ? `<button type="button" class="btn btn-ghost btn-block" data-act="clear">${icon('check')}<span>Vymazať odškrtnuté</span></button>` : ''}
        <button type="button" class="btn btn-danger-ghost btn-block" data-act="delete">${icon('trash')}<span>Zmazať zoznam</span></button>
      </div>`
  });
  wireHelp(s.root);
  const form = s.root.querySelector('[data-form]');

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const patch = { name: form.name.value.trim() || l.name };
    if (owner) patch.shared = form.shared.checked;
    const sharingChanged = owner && patch.shared !== l.shared;
    await store.updateList(listId, patch);
    await s.close();
    if (sharingChanged) toast(patch.shared ? 'Zoznam je teraz zdieľaný s partnerom.' : 'Zoznam je teraz súkromný.', { type: 'success' });
  });

  s.root.querySelector('[data-act=clear]')?.addEventListener('click', async () => {
    const undo = await store.clearChecked(listId);
    await s.close();
    undoToast('Odškrtnuté položky sú vymazané.', undo);
  });

  s.root.querySelector('[data-act=delete]').addEventListener('click', async () => {
    const extra = l.shared ? ' Zoznam zmizne aj partnerovi.' : '';
    const ok = await confirmDialog({
      title: 'Zmazať zoznam?',
      text: `Zoznam „${l.name}“ aj so všetkými položkami bude zmazaný.${extra}`,
      confirmLabel: 'Zmazať',
      danger: true
    });
    if (!ok) return;
    await store.deleteList(listId);
    await s.close();
    toast(`Zoznam „${l.name}“ je zmazaný.`, { type: 'success' });
    onDeleted && onDeleted();
  });
}
