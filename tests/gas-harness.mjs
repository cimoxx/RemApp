// Spustí apps-script/Code.gs v Node s jednoduchými náhradami Google služieb.
// Hárky sú polia riadkov, Script Properties je objekt, tokeninfo vracia, čo test nastaví.
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

class Range {
  constructor(sheet, row, col, rows, cols) { Object.assign(this, { sheet, row, col, rows, cols }); }
  setValues(values) {
    values.forEach((r, i) => {
      const target = (this.sheet.data[this.row - 1 + i] ||= []);
      r.forEach((v, j) => { target[this.col - 1 + j] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v; });
    });
    return this;
  }
  getValues() {
    const out = [];
    for (let i = 0; i < this.rows; i++) {
      const r = this.sheet.data[this.row - 1 + i] || [];
      out.push(Array.from({ length: this.cols }, (_, j) => (r[this.col - 1 + j] ?? '')));
    }
    return out;
  }
  clearContent() {
    for (let i = 0; i < this.rows; i++) {
      const r = this.sheet.data[this.row - 1 + i];
      if (r) for (let j = 0; j < this.cols; j++) r[this.col - 1 + j] = '';
    }
    // orež prázdne riadky na konci, ako to robí getLastRow v Sheets
    while (this.sheet.data.length && this.sheet.data[this.sheet.data.length - 1].every(v => v === '' || v == null)) this.sheet.data.pop();
    return this;
  }
  setFontWeight() { return this; }
  setNumberFormat() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; }
  getLastRow() { return this.data.length; }
  getMaxRows() { return 1000; }
  getRange(row, col, rows = 1, cols = 1) { return new Range(this, row, col, rows, cols); }
  setFrozenRows() {}
}

export function createBackend({ realTime = false } = {}) {
  const sheets = {};
  const props = {};
  const cache = {};
  const tokens = {}; // credential -> tokeninfo
  let clock = 1_700_000_000_000;
  let urlFetches = 0;

  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = new Sheet(n))
  };
  const FakeDate = class extends Date {
    static now() { return realTime ? Date.now() : clock; }
  };
  const sandbox = {
    console,
    Date: FakeDate,
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, openById: () => ss },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (k in props ? props[k] : null),
        getProperties: () => ({ ...props }),
        setProperty: (k, v) => { props[k] = String(v); },
        deleteProperty: k => { delete props[k]; }
      })
    },
    CacheService: {
      getScriptCache: () => ({ get: k => cache[k] ?? null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; } })
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    UrlFetchApp: {
      fetch: url => {
        urlFetches++;
        const cred = decodeURIComponent(url.split('id_token=')[1]);
        const info = tokens[cred];
        return { getResponseCode: () => (info ? 200 : 400), getContentText: () => JSON.stringify(info || { error: 'invalid_token' }) };
      }
    },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeDigest: (_a, text) => [...crypto.createHash('sha256').update(text, 'utf8').digest()].map(b => (b > 127 ? b - 256 : b)),
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' }
    },
    ContentService: {
      createTextOutput: text => ({ text, setMimeType() { return this; } }),
      MimeType: { JSON: 'json' }
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => { const b = { timeBased: () => b, everyWeeks: () => b, onWeekDay: () => b, atHour: () => b, create: () => b }; return b; },
      WeekDay: { MONDAY: 1 }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script/Code.gs'), 'utf8'), sandbox);

  const api = {
    sandbox, sheets, props, cache,
    get urlFetches() { return urlFetches; },
    tick(ms = 1000) { clock += ms; return clock; },
    get now() { return clock; },
    setConfig({ clientId = 'test-client', allowed = [] } = {}) {
      props.CLIENT_ID = clientId;
      props.ALLOWED_EMAILS = allowed.join(', ');
    },
    /** Zaregistruje Google ID token, ktorý „tokeninfo“ uzná. */
    googleToken(email, over = {}) {
      const cred = 'jwt-' + crypto.randomUUID();
      tokens[cred] = { aud: props.CLIENT_ID, iss: 'https://accounts.google.com', exp: String(Math.floor(FakeDate.now() / 1000) + 3600), email, email_verified: 'true', name: email.split('@')[0], ...over };
      return cred;
    },
    /** Raw POST ako z prehliadača; vráti JSON text aj rozparsovaný objekt. */
    post(body) {
      const out = sandbox.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
      return { text: out.text, json: JSON.parse(out.text) };
    },
    call(body) { return api.post(body).json; },
    login(email) {
      const r = api.call({ action: 'login', credential: api.googleToken(email) });
      if (!r.ok) throw new Error('login failed: ' + r.message);
      return r.token;
    }
  };
  return api;
}
