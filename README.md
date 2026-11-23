# RemApp – nákupné zoznamy

Rýchla PWA na nákupné zoznamy pre dvoch. Pamätá si minulé nákupy, zoznamy sa dajú zdieľať s partnerom alebo nechať súkromné. Celé UI je po slovensky a vizuálne patrí do rodiny appky **Flow**.

- **Frontend:** vanilla JS (ES moduly), HTML, CSS. Bez frameworku a bez build kroku, beží priamo na GitHub Pages.
- **Backend:** Google Sheets + Google Apps Script (web app).
- **Prihlásenie:** Google Identity Services + allowlist emailov na serveri.
- **Offline:** IndexedDB, fronta neodoslaných zmien a service worker.

**Adresa:** `https://cimoxx.github.io/RemApp/`

---

## Obsah

1. [Ako to funguje](#ako-to-funguje)
2. [Dátový model](#dátový-model)
3. [Nasadenie krok za krokom](#nasadenie-krok-za-krokom)
4. [Inštalácia na telefón](#inštalácia-na-telefón)
5. [Vývoj, testy a nová verzia](#vývoj-testy-a-nová-verzia)
6. [Ako otestovať zdieľanie a súkromie na dvoch zariadeniach](#ako-otestovať-zdieľanie-a-súkromie-na-dvoch-zariadeniach)
7. [Bezpečnosť a limity](#bezpečnosť-a-limity)

---

## Ako to funguje

```
index.html, styles.css, app.js         – shell, štýly, štart a router (#/, #/list/<id>, #/settings)
sw.js, manifest.json, icons/           – PWA (app shell cache-first, ikony 192/512 + maskable)
js/version.js                          – APP_VERSION (jediný zdroj verzie, číta ho aj sw.js)
js/changelog.js                        – zoznam zmien zobrazený v Nastaveniach
js/config.js                           – URL Apps Scriptu a Google Client ID
js/auth.js                             – Google prihlásenie, session token
js/api.js                              – POST text/plain (bez CORS preflightu), chyby po slovensky
js/db.js                               – IndexedDB (lists, items, history, prefs, outbox, meta)
js/store.js                            – stav v pamäti, lokálne zmeny, zlúčenie odpovede servera
js/sync.js                             – delta synchronizácia, debounce 500 ms, polling 10 s
js/history.js, js/categories.js        – návrhy, čipy, slovník oddelení
js/ui.js, js/views/*                   – toasty, bottom sheety, obrazovky
apps-script/Code.gs                    – backend: overenie, oprávnenia, LWW, história, čistenie
tests/                                 – testy backendu, klienta a end-to-end test dvoch používateľov
```

**Tok zmeny:** ťuk v UI → zmena sa hneď zapíše do pamäte a IndexedDB a vloží do outboxu → po 500 ms ju `sync.js` odošle → server ju pod `LockService` zapíše a v tej istej odpovedi vráti zmeny od `lastSyncAt` (deltu) → klient ich zlúči.

**Synchronizácia:**
- Kým je appka viditeľná, synchronizuje sa každých 10 s. Na pozadí (`visibilitychange`) sa polling zastaví a po návrate sa hneď synchronizuje.
- Konflikty rieši pravidlo **last-write-wins na úrovni riadku** podľa `updatedAt`. Hodiny klienta sa zarovnávajú s hodinami servera.
- **Mazanie je soft delete** (`deleted=true`), aby sa prenieslo aj na druhé zariadenie. Týždenný trigger `purge` čistí tombstony staršie ako 30 dní. Klient s kurzorom starším ako posledné čistenie automaticky dostane úplnú synchronizáciu.
- **Offline:** zmeny čakajú v outboxe a odošlú sa po pripojení. Indikátor v hlavičke ukazuje stav: `OK` / `Sync` / `Čaká N` / `Offline` / `Chyba`. Ťuk naň synchronizuje hneď.
- **Service worker:** app shell je cache-first. Dáta idú cez POST priamo na Apps Script; SW ich nekešuje, offline dáta drží IndexedDB. Fonty sú stale-while-revalidate, ostatné GET požiadavky network-first.

**Prihlásenie:**
1. Tlačidlo „Prihlásiť sa cez Google“ (Google Identity Services, `auto_select` na tiché prihlásenie) vráti Google ID token (JWT).
2. Apps Script ho overí cez `tokeninfo` (podpis a `exp`), skontroluje `aud` (tvoj Client ID), `iss`, `email_verified` a **allowlist** a výsledok overenia nacachuje v `CacheService`.
3. Server vydá vlastný **session token** na 30 dní. Pri používaní sa platnosť predlžuje, takže sa netreba prihlasovať každú hodinu, keď vyprší Google token. Na serveri sa ukladá iba SHA-256 hash tokenu.
4. Každá požiadavka posiela session token. **Allowlist sa kontroluje pri každej požiadavke**, takže odobratie emailu platí okamžite.

**Súkromie:** každý zoznam má `owner` a `shared`. Filtrovanie robí **server**:
- Partner nikdy nedostane súkromný zoznam vlastníka: ani názov, ani položky, ani históriu.
- Keď vlastník vypne zdieľanie, partner dostane iba `revoked: [id]` a klient zoznam zmaže aj z IndexedDB.
- Zdieľanie môže zapnúť alebo vypnúť iba vlastník. Server to vynucuje aj vtedy, keby klient poslal niečo iné.
- Na zdieľanom zozname majú obaja inak rovnaké práva: premenovať, upravovať položky aj zmazať zoznam.

**Ovládanie:**
- Ťuk na položku ju odškrtne alebo odznačí (s vibráciou). Odškrtnuté položky idú dole do sekcie „V košíku“.
- Potiahnutie doľava položku zmaže; toast „Späť“ ju do 5 s vráti.
- Dlhé podržanie alebo ceruzka otvorí úpravu položky.
- Pri písaní sa ponúkajú návrhy z histórie (bez diakritiky, zoradené podľa frekvencie a toho, kedy sa položka naposledy kupovala). Pod poľom sú čipy s najčastejšími položkami.
- Rýchle zadanie množstva: „2 rožky“, „2x mlieko“, „500 g syr“, „syr 500g“.

---

## Dátový model

Hárky v Google Sheets vytvorí funkcia `setup()`. Prvý riadok je hlavička, všetky bunky sú formátované ako text.

| Hárok | Stĺpce |
|---|---|
| `Lists` | id, name, owner, shared, createdAt, updatedAt, updatedBy, deleted, **sharedChangedAt**, **serverAt** |
| `Items` | id, listId, name, qty, note, category, checked, **checkedAt**, order, createdAt, updatedAt, updatedBy, deleted, **serverAt** |
| `History` | key, owner, displayName, category, lastQty, lastNote, count, lastUsedAt, **updatedAt**, **deleted**, **serverAt** |
| `Prefs` *(nový)* | owner, key, value, updatedAt, serverAt |

**Úpravy oproti pôvodnému návrhu a prečo:**

1. **`serverAt` v každom riadku (čas servera pri zápise) je kurzor delta synchronizácie.** Kurzor podľa klientského `updatedAt` by strácal offline zmeny. Napríklad telefón offline zapíše zmenu o 10:00, odošle ju o 10:30, ale partner, ktorý sa naposledy synchronizoval o 10:15, by ju nikdy nedostal. Pravidlo LWW naďalej porovnáva `updatedAt`.
2. **`Lists.sharedChangedAt`** (čas posledného prepnutia zdieľania):
   - Pri *súkromný → zdieľaný* partner dostane **všetky** položky zoznamu, aj staršie ako jeho kurzor.
   - Pri *zdieľaný → súkromný* partner dostane iba id v `revoked`, nič viac.
3. **Históriu udržiava server.** Klient nemôže počítadlo `count` iba prepisovať: dve zariadenia by si navzájom prepisovali čísla, kým LWW funguje len na celé hodnoty. Server preto pri pridaní položky zvýši `count` a uloží posledné množstvo, poznámku a oddelenie. Zároveň zaručí, že položka zo súkromného zoznamu sa zapíše iba pod email vlastníka (`owner = email`) a zo zdieľaného pod `*`. Od klienta prijíma iba zmazanie záznamu (z Nastavení). Stĺpce `updatedAt`, `deleted` a `serverAt` slúžia na prenos zmazania na druhé zariadenie.
4. **Kategória je stabilný kľúč** (`ovocie`, `pecivo`, `mliecne`, `maso`, `mrazene`, `trvanlive`, `napoje`, `drogeria`, `domacnost`, `ine`), nie text. Názov oddelenia sa dá zmeniť bez rozbitia dát.
5. **`Lists.order` je nahradené hárkom `Prefs`** (`listOrder`, `categoryOrder`). Poradie zoznamov aj oddelení má každý svoje. Keby partner presunul zoznam, nezmenilo by sa poradie tebe.
6. **`Items.checkedAt`** zoraďuje sekciu „V košíku“ od naposledy odškrtnutej položky.

---

## Nasadenie krok za krokom

### 1. Google Sheet

1. Otvor [sheets.new](https://sheets.new) a pomenuj tabuľku napr. **RemApp – dáta**.
2. Hárky nevytváraj ručne, urobí to skript v ďalšom kroku.

### 2. Apps Script

1. V tabuľke otvor **Rozšírenia → Apps Script** (Extensions → Apps Script). Skript tak bude viazaný na túto tabuľku.
2. Premenuj projekt na **RemApp API**.
3. Obsah `Code.gs` nahraď celým súborom [`apps-script/Code.gs`](apps-script/Code.gs) a ulož (Ctrl+S).
4. *(Voliteľné)* V **Project Settings** zapni „Show appsscript.json manifest file in editor“ a obsah `appsscript.json` nahraď súborom [`apps-script/appsscript.json`](apps-script/appsscript.json). Nastaví sa tým V8 runtime a časové pásmo.
5. V editore vyber funkciu **`setup`** a klikni **Run**. Google si vyžiada oprávnenia (prístup k tabuľke, externé požiadavky, triggery). Pri „Google hasn’t verified this app“ klikni **Advanced → Go to RemApp API (unsafe)**. Je to tvoj vlastný skript.
6. Skontroluj, že v tabuľke pribudli hárky `Lists`, `Items`, `History` a `Prefs` a v **Triggers** (ikona budíka) týždenný trigger `purge`.
7. **Deploy → New deployment → typ Web app:**
   - *Description:* `v1.0.0`
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
8. Klikni **Deploy** a skopíruj **Web app URL** (končí na `/exec`).

> „Anyone“ znamená, že endpoint je dostupný z internetu, nie že sú dostupné dáta. Každá akcia okrem prihlásenia vyžaduje platný session token a email na allowliste. Bez neho server vráti iba chybu.
>
> **Aktualizácia backendu:** po zmene `Code.gs` choď do **Deploy → Manage deployments → ✏️ → Version: New version → Deploy**. URL ostane rovnaké.

### 3. OAuth Client ID (Google Cloud Console)

1. Otvor [console.cloud.google.com](https://console.cloud.google.com/), vytvor nový projekt **RemApp** a prepni sa doň.
2. **APIs & Services → OAuth consent screen** (v novom rozhraní **Google Auth Platform**) → **Get started**:
   - *App name:* `RemApp`, *User support email:* tvoj email
   - *Audience:* **External**
   - *Contact information:* tvoj email → **Create**
3. **Audience → Test users → Add users:** pridaj seba aj partnera. *(Alternatíva: Publish app. Prihlásenie používa iba základné údaje `openid email profile`, takže overenie od Google netreba.)*
4. **Clients → Create client:**
   - *Application type:* **Web application**
   - *Name:* `RemApp web`
   - **Authorized JavaScript origins:**
     - `https://cimoxx.github.io`
     - `http://localhost`
     - `http://localhost:8080`
   - *Authorized redirect URIs:* nechaj prázdne (Google Identity Services ich nepoužíva).
5. Klikni **Create** a skopíruj **Client ID** (`…apps.googleusercontent.com`).

> Origin je iba schéma + doména + port, **bez** `/RemApp/`. Zmena originov sa môže prejaviť až po niekoľkých minútach.

### 4. Allowlist a Client ID v Script Properties

V Apps Script editore otvor **Project Settings (⚙️) → Script Properties → Add script property**:

| Property | Hodnota |
|---|---|
| `CLIENT_ID` | Client ID z kroku 3 |
| `ALLOWED_EMAILS` | `ja@gmail.com, partner@gmail.com` (čiarkou oddelené, veľkosť písmen nehrá rolu) |

Zmeny platia hneď, bez nového nasadenia. Odobratý email stratí prístup pri najbližšej požiadavke. Funkcia `revokeAllSessions` (spustiteľná z editora) odhlási všetky zariadenia.

### 5. Konfigurácia appky a GitHub Pages

1. V súbore [`js/config.js`](js/config.js) doplň:
   ```js
   export const API_URL = 'https://script.google.com/macros/s/…/exec';
   export const GOOGLE_CLIENT_ID = '…apps.googleusercontent.com';
   ```
   Obe hodnoty sú verejné identifikátory, nie tajomstvá, takže môžu byť v repe.
2. Commitni a pushni do vetvy `main`.
3. Na GitHube otvor **Settings → Pages**:
   - *Source:* **Deploy from a branch**
   - *Branch:* **main**, priečinok **/ (root)** → **Save**
4. Po minúte až dvoch beží appka na **https://cimoxx.github.io/RemApp/**.
   GitHub Pages pre súkromné repo vyžaduje platený plán. Pri bezplatnom účte musí byť repo verejné, čo je v poriadku: v repe nie sú žiadne dáta ani tajomstvá.

Súbor `.nojekyll` v koreni vypína spracovanie cez Jekyll, takže GitHub Pages servíruje súbory tak, ako sú.

---

## Inštalácia na telefón

- **Android (Chrome):** otvor adresu, v menu ⋮ zvoľ **Inštalovať aplikáciu** (alebo „Pridať na plochu“).
- **iOS (Safari):** Zdieľať → **Pridať na plochu**. Prihlásenie funguje. Ak iOS v režime inštalovanej appky tiché prihlásenie nepustí, stačí raz ťuknúť na tlačidlo. Session potom platí 30 dní a predlžuje sa.

---

## Vývoj, testy a nová verzia

**Lokálne spustenie:**
```bash
python3 -m http.server 8080
# otvor http://localhost:8080 (origin musí byť v OAuth klientovi, krok 3)
```

**Testy** (Node 20+, žiadne závislosti):
```bash
node --test tests/*.test.mjs          # backend (Code.gs v simulácii) + klientske moduly
node tests/e2e/two-users.mjs out/     # voliteľné: 2 používatelia v Chromiu (vyžaduje Playwright)
```
- `tests/server.test.mjs` spúšťa skutočný `Code.gs` nad simulovaným Sheets, Properties a tokeninfo. Overuje prihlásenie, allowlist, súkromie (aj v **surovej odpovedi API**), LWW, tombstony, čistenie, históriu a ochranu proti vzorcom.
- `tests/e2e/two-users.mjs` prejde celý scenár v prehliadači pre dvoch ľudí: pridanie, swipe so Späť, dlhé podržanie, návrhy, čipy, zdieľanie zapnúť/vypnúť, offline + reload, históriu.

**Nová verzia:**
1. Zvýš `APP_VERSION` v [`js/version.js`](js/version.js). Tým sa zmení aj názov cache v service workeri.
2. Pridaj záznam na začiatok [`js/changelog.js`](js/changelog.js).
3. Ak sa menil nejaký JS/CSS súbor alebo pribudol nový, skontroluj zoznam `SHELL` v `sw.js`.

Po nasadení sa používateľom v appke zobrazí lišta **„Je dostupná nová verzia“** s tlačidlom **Načítať**.

**Ikony:** `python3 tools/make_icons.py icons` (vyžaduje Pillow).

---

## Ako otestovať zdieľanie a súkromie na dvoch zariadeniach

Zariadenie **A** = ty (vlastník), zariadenie **B** = partner. Obaja máte email v `ALLOWED_EMAILS`.

**1. Prístup**
- [ ] Na treťom účte (mimo allowlistu) sa prihlás → musí sa zobraziť „Účet … nemá prístup k RemApp.“
- [ ] Otvor Web app URL priamo v prehliadači → `{"ok":false,"code":"use_post",…}`, žiadne dáta.
- [ ] Bez tokenu: `curl -L -H 'Content-Type: text/plain' -d '{"action":"sync","since":0}' '<WEB_APP_URL>'` → `"code":"auth"`.

**2. Zdieľaný zoznam**
- [ ] A: vytvor zoznam **Lidl** (prepínač „Zdieľať s partnerom“ zapnutý) a pridaj „mlieko“ a „2 rožky“.
- [ ] B: do ~10 s uvidí Lidl s oboma položkami (alebo ťukni na `OK` v hlavičke).
- [ ] B: odškrtni Mlieko → na A sa presunie do „V košíku“.
- [ ] B: v nastaveniach zoznamu (⋮) **nie je** prepínač zdieľania, iba informácia o vlastníkovi.

**3. Súkromný zoznam**
- [ ] A: vytvor zoznam **Darček** s **vypnutým** zdieľaním a pridaj „Prsteň“.
- [ ] B: po synchronizácii Darček **nevidí**. V návrhoch pri písaní „prs“ sa nič nezobrazí a v Nastaveniach → História „Prsteň“ chýba.
- [ ] **Kontrola surovej odpovede API na B:** otvor appku na B v Chrome na počítači (alebo cez `chrome://inspect` pre Android), otvor DevTools → **Console** a spusti:
  ```js
  const { API_URL } = await import('./js/config.js');
  const { token } = JSON.parse(localStorage.remapp_session_v1);
  const raw = await (await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action: 'sync', token, since: 0 }) })).text();
  console.log(raw.includes('Darček'), raw.includes('Prsteň'), raw.length);   // musí byť: false false …
  ```
  Alebo v **Network** odfiltruj `exec`, otvor odpoveď a hľadaj (Ctrl+F) „Darček“ – nesmie sa nájsť.

**4. Prepnutie zdieľania**
- [ ] A: Lidl → ⋮ → vypni „Zdieľať s partnerom“ → Uložiť.
- [ ] B: zoznam do ~10 s zmizne (ak bol B práve v ňom, presmeruje ho domov s hláškou). V Network odpovedi je iba `"revoked":["<id>"]`, bez názvu a položiek. V DevTools → Application → IndexedDB → `remapp` → `items` nie sú položky Lidl.
- [ ] A: zdieľanie znova zapni → B dostane Lidl aj so **všetkými** položkami, aj tými, ktoré A pridal počas súkromného režimu.

**5. Offline a konflikty**
- [ ] B: zapni režim lietadlo, pridaj položku → indikátor `Offline`/`Čaká`. Zatvor a znova otvor appku → položka tam je. Vypni režim lietadlo → odošle sa a A ju uvidí.
- [ ] Obaja naraz upravte tú istú položku (napr. množstvo) → po synchronizácii majú obaja verziu z neskoršej úpravy.
- [ ] A: swipe vľavo na položke → toast „Späť“ → po 5 s sa zmazanie prejaví aj na B.

**6. Odobratie prístupu**
- [ ] V Script Properties odober email B z `ALLOWED_EMAILS` → B pri najbližšej synchronizácii uvidí prihlasovaciu obrazovku s hláškou, že účet už nemá prístup.

---

## Bezpečnosť a limity

- **Overenie:** `tokeninfo` overuje podpis aj expiráciu Google tokenu. Server ďalej kontroluje `aud` (Client ID), `iss`, `email_verified` a allowlist.
- **Session token:** server ukladá iba jeho hash. Token platí 30 dní a predlžuje sa pri používaní. Odhlásenie ho na serveri zneplatní. Pri odhlásení sa vymaže aj IndexedDB v zariadení. Ak sa na tom istom zariadení prihlási iný účet, lokálne dáta sa najprv zmažú.
- **Server je jediný arbiter:** vlastníka nastavuje server, `shared` mení iba vlastník, zápisy do cudzieho súkromného zoznamu server odmietne. Hodiny klienta v budúcnosti orezáva (najviac +60 s), takže sa nedá podvádzať pri LWW.
- **Vzorce:** text, ktorý začína `=`, `+`, `-` alebo `@`, sa uloží ako text, nie ako vzorec. Bunky sú formátované ako text, takže „1,5“ ostane „1,5“.
- **XSS:** všetok obsah od používateľov sa pred vložením do HTML escapuje. Content Security Policy povoľuje skripty iba z vlastnej domény a z Google Identity Services.
- **Kvóty Apps Script:** UrlFetch (`tokeninfo`) sa volá iba pri prihlásení. Polling bez zmien ide „rýchlou cestou“: server prečíta iba Script Properties, nie hárky. Pri bežnom používaní dvoch ľudí sú kvóty ďaleko.
- **Z Flow sa neprenieslo:** endpoint bez autentifikácie (GET bez tokenu nevracia nič, ani verziu), externé ikony a manifest bez maskable ikony a `id`.
