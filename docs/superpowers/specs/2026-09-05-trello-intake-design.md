# Trello intake → Jira — design

Status: approvato (brainstorming), in attesa del piano di implementazione.
Branch: `feature/trello-intake`.

## Contesto e problema

Le richieste dei clienti arrivano su Trello, non su Jira. Oggi qualcuno legge
a mano le board dei clienti (14 board aperte, una per cliente o per filone di
lavoro) e trascrive le richieste in issue Jira, che è l'unica cosa su cui la
flotta di munder-difflin sa lavorare: `jira-poll` reclama le issue assegnate
all'utente in "To Do" e le assegna a un agente (vedi
`2026-08-29-jira-project-mapping-design.md`).

Obiettivo: automatizzare **solo il primo tratto** di quella catena — da card
Trello a issue Jira — lasciando invariato tutto il resto.

```
card Trello (cliente/commerciale)
  → [questo lavoro] god crea la issue Jira corrispondente
     → un umano la assegna in Jira
        → jira-poll (già esistente) la reclama e la assegna a un agente
           → il team lavora SOLO su Jira
```

Trello **non** è un secondo Jira e non è un provider di pari grado: è la
sorgente a monte. La flotta non tocca mai Trello, e nessuna card viene
modificata da munder-difflin.

## Cosa esiste già (verificato nel codice reale, non assunto)

- `src/shared/jiraProjects.ts` — `JiraProjectBinding { key, repo, baseBranch,
  agents?, enabled }`, `JiraPollSettings`, validatori puri. Framework-agnostic.
- `src/main/jiraProjects.ts` — CRUD su config + `validateJiraProjectBinding`
  con dipendenze iniettate (`isRepo`/`getBranches`/`agentExists`/`testJiraKey`).
  `testJiraKey` è **opzionale**: quando l'integrazione Jira non è configurata
  il controllo remoto si salta invece di bloccare il salvataggio.
- `src/main/index.ts:387` — `getJiraBindings: () => ({ bindings:
  listBindings().filter(b => b.enabled), poll: readConfig().jiraPoll })`.
  Serializza il **binding intero**: un campo nuovo sul tipo arriva a god senza
  toccare il broker.
- `src/main/integrationBroker.ts` — rotta `GET /jira-bindings`, leggibile con
  qualunque capability token valido.
- `src/shared/mcpCatalog.ts` — `MCP_CATALOG` con `McpCatalogEntry { id, label,
  description, spec: { command, args, env? }, tier, defaultEnabled }`. Tier
  `safe-readonly` acceso di default, `write`/`secret` spenti e consent-gated.
- `src/main/hive.ts:1219` — `buildDefaultMcpServers(cwd, cfg)`: costruisce il
  blocco `mcpServers` del `settings.json` **per-sessione**, namespacizzando
  ogni id `munder-<id>`. Il set è **identico per ogni agente**; la funzione non
  riceve l'identità dell'agente. Il chiamante (riga 972, dentro `hookSettings`)
  ha però `meta` in mano.
- `HarnessConfig.mcpDefaults?: { [id]: { enabled: boolean } }` (`config.ts:295`),
  con UI in `src/renderer/src/components/McpDefaultsSettings.tsx`.
- `src/renderer/src/components/JiraProjectsRegistry.tsx` — CRUD dei binding in
  Settings → Connections.
- `src/renderer/src/hooks/useResolvedRepoNames.ts` — `projectTag(agent)`,
  suffisso solo-display che porta la chiave Jira.
- Il server MCP Trello dell'utente: stdio locale, `/opt/homebrew/bin/bun
  /Users/shaibon/www/magenio-mcp/trello-mcp/build/index.js`, credenziali lette
  da sé (`TRELLO_API_KEY`/`TRELLO_TOKEN` nel proprio `.env`), **nessuna**
  modalità read-only e **nessun** allow-list di tool: espone anche
  `create_board`, `archive_list`, `update_card_details`.
- Realtà delle board (verificata via MCP): board identificate da `id` (24 hex)
  e `shortLink` (8 char, es. `781LrPy9`), entrambi immutabili; `name`
  modificabile. Le liste hanno id 24-hex e nomi modificabili. La board
  BurdaStyle ha 8 liste tra cui **due** candidate a intake (`Da fare` e
  `Da fare [team Burda Style]`), più `Approvati`. Trello non ha nessun
  equivalente della chiave breve di Jira (`BURD`).

## Decisioni prese in brainstorming (fuori scope ridiscuterle)

1. **Trello è a monte di Jira**, non un connettore parallelo. Ogni card
   triaggiata diventa una issue Jira; il team lavora solo su Jira.
2. **Trello è in sola lettura.** Nessuna scrittura di nessun tipo: né commenti,
   né spostamenti di card, né etichette. Il legame vive sulla issue Jira.
3. **Un binding mappa board → chiave Jira.** Repo, branch base e agenti non si
   duplicano: arrivano per transitività dal `JiraProjectBinding` con quella
   chiave. Una board senza un progetto Jira dietro **non è configurabile**, ed
   è un vincolo accettato.
4. **Il dato vive dentro `JiraProjectBinding`**, come campo opzionale, non in
   un registro separato — così un binding Trello orfano (che punta a un
   progetto Jira cancellato) è inesprimibile per costruzione. Tipi e validatori
   stanno però in un **modulo proprio**, così l'estrazione futura in un
   registro autonomo è una rifattorizzazione meccanica.
5. **Tutte le card della lista di intake qualificano.** La lista è il filtro:
   si punta il binding su una lista già curata da un umano. Nessun filtro per
   membro assegnato o per etichetta.
6. **Il riferimento alla card vive su Jira** come label `trello-<shortLink>`
   (chiave di deduplica, interrogabile in una sola JQL) più un remote issue
   link (affordance umana).
7. **L'accesso a Trello passa dall'MCP**, non da credenziali REST nel main
   process, ristretto a un insieme esplicito di agenti con uno scoping
   per-agente. Oggi quell'insieme è `['god']`; il meccanismo accetta una lista,
   quindi aggiungere il PM è configurazione, non codice.
8. **La issue creata non è assegnata.** Resta in "To Do" senza assegnatario
   finché un umano non la prende: `jira-poll` reclama solo issue assegnate,
   quindi il cancello umano tra Trello e la flotta è strutturale, non una
   convenzione.
9. **Trascrizione, non interpretazione**: la issue riporta le parole della
   card, non una riscrittura fatta da un LLM.
10. **`projectTag` non si tocca.** Gli agenti lavorano su issue Jira e il tag
    che vedono è già quello giusto; god non ha tag (`isGod` ritorna stringa
    vuota). Nessuna modifica a `useResolvedRepoNames.ts`.

## A. Modello dati

Nuovo modulo `src/shared/trelloIntake.ts`, framework-agnostic esattamente come
`shared/jiraProjects.ts` (nessun `node:fs`, nessun electron), importabile da
main, preload e renderer.

```ts
export interface TrelloIntakeBinding {
  /** shortLink della board, estratto dall'URL (es. "781LrPy9"). Immutabile,
   *  e accettato dall'API Trello ovunque accetti un board id. */
  boardShortLink: string;
  /** Nome della board — SOLO visualizzazione, mai identità. */
  boardLabel: string;
  /** Nomi ESATTI delle liste di intake, risolti da god contro la board viva
   *  a ogni giro. Non id: il main process non può interrogare Trello, quindi
   *  un id andrebbe recuperato a mano fuori dall'app. */
  intakeLists: string[];
  /** Accende/spegne l'intake indipendentemente dall'`enabled` del progetto. */
  enabled: boolean;
}
```

Campo additivo e opzionale su `JiraProjectBinding`
(`src/shared/jiraProjects.ts`):

```ts
  /** Sorgente Trello a monte di questo progetto: le card di queste liste
   *  diventano issue di `key`. Assente = nessun intake Trello. */
  trello?: TrelloIntakeBinding;
```

Nessun nuovo campo top-level in `HarnessConfig`: il dato vive dentro
`jiraProjects`, già persistito, già validato, già esposto in IPC e già servito
dal broker. **Nessuna migrazione**: una config esistente non ha il campo e si
carica invariata.

### Funzioni pure del modulo

```ts
/** shortLink di board: 8 caratteri alfanumerici. */
export const TRELLO_SHORTLINK_RE = /^[A-Za-z0-9]{8}$/;

/** Estrae lo shortLink da un URL di BOARD (https://trello.com/b/<short>/<slug>).
 *  Ritorna null per un host diverso, per un URL di card (/c/<short>) e per
 *  qualunque forma non riconosciuta. Accetta l'URL con o senza slug finale e
 *  con o senza slash di coda. Non lancia mai. */
export function parseTrelloBoardUrl(url: string): string | null;

/** La label Jira che marca una issue come nata da una card Trello. Usa lo
 *  shortLink della CARD (globalmente unico e immutabile), mai il suo id lungo
 *  né il titolo. È LA chiave di deduplica del poll: cambiare questa funzione
 *  significa ri-creare l'intero backlog. */
export function jiraLabelForCard(cardShortLink: string): string; // "trello-781LrPy9"

/** URL pubblico di una card, per il remote issue link. */
export function trelloCardUrl(cardShortLink: string): string;

/** Ritorna un messaggio di errore, o null quando il binding è valido.
 *  Regole: shortLink presente e ben formato; almeno una lista di intake;
 *  nessun nome di lista vuoto; nessun nome duplicato (case-insensitive). */
export function validateTrelloIntake(t: TrelloIntakeBinding): string | null;
```

`jiraLabelForCard` sta qui e non nel prompt della mission perché è il punto su
cui poggia la correttezza dell'intero meccanismo: deve essere una funzione
sola, condivisa fra il body della mission (che la cita nella sua forma
testuale) e i test, non una stringa riscritta a mano in due posti.

### Validazione

`validateJiraProjectBinding` (`src/main/jiraProjects.ts`) chiama
`validateTrelloIntake` quando `binding.trello` è presente, subito dopo i
controlli su repo e branch e prima del controllo remoto della chiave Jira.

La validazione resta **di solo formato**. Il main process non ha nessuna via
per parlare con Trello (decisione 7), quindi non può verificare che la board o
le liste esistano davvero. Una board o una lista inesistente si scopre al primo
giro di poll, con un errore che la nomina esplicitamente. Non si introduce
nessuna dipendenza iniettata `testTrelloBoard`: sarebbe un parametro che
nessun chiamante può soddisfare.

## B. Accesso MCP ristretto

### Entry di catalogo configurabile dall'utente

`McpCatalogEntry` guadagna un flag:

```ts
  /** Il comando di lancio NON è distribuibile (server locale, path assoluto,
   *  binario dell'utente): `spec` è un segnaposto e i valori reali arrivano da
   *  `config.mcpDefaults[id].command/args`. */
  userConfigured?: boolean;
```

Nuova entry:

```ts
  {
    id: 'trello',
    label: 'Trello (sola lettura)',
    description: 'Legge board, liste e card di Trello. Comando e credenziali sono configurati da te: il server gestisce il proprio token.',
    spec: { command: '', args: [] },
    tier: 'write',
    defaultEnabled: false,
    userConfigured: true
  }
```

Tier `write` e non `secret`: `secret` significa "l'app custodisce una
credenziale e la inietta", che qui non accade — il token vive nel `.env` del
server MCP. Entrambi i tier sono spenti di default e richiedono consenso
esplicito, quindi la protezione è identica; `write` è semplicemente la
descrizione vera. **Conseguenza da mettere per iscritto**: munder-difflin non
può verificare, ruotare né revocare quella credenziale, e non sa dire se è
valida — un token Trello scaduto si manifesta come un errore nel run di god.

L'etichetta dice "sola lettura" perché è così che la mission lo usa, non perché
il server lo imponga: il server espone anche tool di scrittura (vedi Rischi).

### Consenso esteso

`HarnessConfig.mcpDefaults` (`src/main/config.ts`, specchiato in
`src/renderer/src/store/config.ts` e `src/preload/index.ts`):

```ts
mcpDefaults?: {
  [id: string]: {
    enabled: boolean;
    /** Se presente e NON vuoto: solo questi agent id ricevono il server.
     *  Assente o vuoto = tutti gli agenti (comportamento odierno, invariato). */
    agents?: string[];
    /** Override del comando. Onorato SOLO per entry con userConfigured: true;
     *  ignorato (e il server escluso, perché lo spec è vuoto) altrimenti. */
    command?: string;
    args?: string[];
  }
}
```

### Scoping in `hive.ts`

`buildDefaultMcpServers(cwd, cfg)` → `buildDefaultMcpServers(cwd, cfg, agentId)`
e `hookSettings(shim, cwd, cfg, theme, writableDirs)` →
`hookSettings(shim, agentId, cwd, cfg, theme, writableDirs)`. Il call site
(riga 972) ha già `meta.id`.

Regole di inclusione, nell'ordine, dentro il ciclo esistente:

1. `enabled` (consenso ?? `defaultEnabled`) — invariato.
2. Un tier diverso da `safe-readonly` richiede `consented === true` — invariato.
3. **Nuovo:** se `agents` è presente e non vuoto e non contiene `agentId`,
   salta il server.
4. **Nuovo:** se `userConfigured`, usa `command`/`args` dal consenso; se
   `command` è assente o vuoto, salta il server (una entry non configurata non
   produce un `mcpServers` rotto nel `settings.json` dell'agente).
5. Per le entry NON `userConfigured`, `command`/`args` del consenso sono
   ignorati — difesa in profondità nello stesso stile della regola 2: un
   `config.json` modificato a mano non deve poter trasformare il server
   `filesystem` in un binario arbitrario lanciato in ogni agente.

Il namespacing `munder-<id>` e la sostituzione del segnaposto `<cwd>` restano
invariati.

Configurazione attesa dall'utente: `mcpDefaults.trello = { enabled: true,
agents: ['god'], command: '/opt/homebrew/bin/bun', args: ['/Users/shaibon/www/magenio-mcp/trello-mcp/build/index.js'] }`.

## C. La mission di intake

Nuova `TRELLO_INTAKE_MISSION` in `src/main/config.ts`, stesso pattern di
`JIRA_POLL_MISSION`:

- `id: 'trello-intake'`, `label: 'Trello intake → Jira'`
- `to: 'god'` — è una decisione di orchestrazione, e god è l'unico agente a cui
  lo scoping MCP concede Trello.
- `intervalMs: 900_000` (15 minuti). Il triage non ha l'urgenza del claim, e un
  intervallo più lungo riduce la superficie di un errore ripetuto.
- `enabled: false` — opt-in, come l'heartbeat e come `jira-poll`: crea issue su
  un tracker reale.
- Guardia di seeding `trelloIntakeSeeded?: boolean` in `HarnessConfig`, mirror
  di `jiraPollSeeded`: non viene ri-aggiunta dopo una cancellazione manuale.

### Procedura nel body

Per ogni binding restituito da `GET /jira-bindings` che abbia
`trello.enabled === true`:

1. Leggere le card di ogni lista in `trello.intakeLists`, risolvendo i nomi
   contro la board `trello.boardShortLink` via MCP. Una lista che non esiste
   sulla board si riporta come errore che la nomina, e si prosegue con le
   altre.
2. Costruire per ogni card la label `trello-<shortLink della card>`.
3. **Una** JQL per binding: `project = <key> AND labels in ("trello-…", …)`,
   che restituisce le card già tracciate.
4. Per ogni card la cui label non compare nel risultato, creare una issue nel
   progetto `<key>` con: summary = titolo della card; description = descrizione
   della card, eventuali item di checklist, e il link alla card; label
   `trello-<shortLink>`; remote issue link all'URL della card con `globalId`
   uguale alla label.
5. **Nessun assegnatario, nessuna transizione di stato**: la issue resta in
   "To Do" non assegnata finché un umano non la prende (decisione 8).
6. **Nessuna scrittura su Trello, mai** — nessun commento, nessuno spostamento,
   nessuna etichetta.
7. Riportare nel run: quante card lette, quante già tracciate, quante create
   (con le chiavi), quali liste non trovate.

### Paletti obbligatori nel body

Sono i modi in cui questa mission fa danni, e vanno scritti come regole
esplicite:

- **Se la JQL del passo 3 fallisce o è ambigua, il binding si abortisce senza
  creare nulla.** Una query fallita non è "nessun duplicato": è il caso in cui
  god ricrea l'intero backlog. È la singola regola più importante del prompt.
- **Tetto di 10 nuove issue per binding per ciclo.** Oltre quel numero si
  creano le prime 10 e si riporta il resto nel run. Limita il danno di una
  lista puntata male (una lista con 200 card) o di una deduplica rotta.
- **Trascrizione, non interpretazione.** Le parole del cliente arrivano su Jira
  come sono state scritte. La issue è il punto di partenza che un umano
  raffina, non la rielaborazione di un LLM di una richiesta commerciale.

I **dati** (quali board, quali liste, quale progetto) restano nei binding:
aggiungere una board non tocca il body della mission.

### Broker

**Nessuna modifica.** `getJiraBindings` serializza il binding intero, quindi il
campo `trello` viaggia già dentro la risposta di `GET /jira-bindings`.
`resources/skills/capabilities/SKILL.md` guadagna una frase che dice che il
binding può portare un blocco `trello`.

## D. UI

**`JiraProjectsRegistry.tsx`** — dentro la riga di progetto già esistente, una
sottosezione "Sorgente Trello", assente finché non la si aggiunge
esplicitamente: URL della board (da cui si deriva `boardShortLink` con
`parseTrelloBoardUrl` e si pre-compila `boardLabel` dallo slug — che è minuscolo e con trattini, quindi il campo resta editabile e ci si aspetta che l'utente lo corregga),
nomi delle liste di intake, e l'interruttore `enabled` dell'intake. Il registro
resta uno: la gerarchia visiva dice la verità sul modello dati — Trello è una
sorgente *di* un progetto Jira, non un pari grado.

**`McpDefaultsSettings.tsx`** — per le sole entry `userConfigured: true`, tre
campi aggiuntivi: comando, argomenti, e la lista di agent id ammessi. Per ogni
altra entry la UI non cambia.

Stringhe i18n in tutti e tre i locale: `en.json`, `zh-CN.json`, `ar.json`.

## E. Definizione di fatto

Test nuovi sotto `test/*.test.cjs` (`npm run test:focused`):

1. **Modulo puro** — `parseTrelloBoardUrl` su: URL con slug, senza slug, con
   slash finale, con query string, host diverso da trello.com, URL di *card*
   (`/c/…`) invece che di board, stringa vuota. `jiraLabelForCard` e
   `trelloCardUrl` sulla forma attesa. `validateTrelloIntake` regola per regola:
   shortLink assente, shortLink malformato, zero liste, nome di lista vuoto,
   nomi duplicati con case diverso.
2. **Validazione binding** — un `JiraProjectBinding` con un `trello` malformato
   è rifiutato al salvataggio con un messaggio che nomina il campo; uno senza
   `trello` passa esattamente come oggi (regressione).
3. **Config** — una config priva del campo si carica invariata;
   `TRELLO_INTAKE_MISSION` ha `id: 'trello-intake'`, `to: 'god'`,
   `enabled: false`, e il body contiene sia la regola di aborto sulla JQL
   fallita sia il tetto per ciclo.
4. **Broker** — `GET /jira-bindings` restituisce il campo `trello` quando il
   binding ce l'ha, e produce una risposta di forma identica a oggi quando non
   ce l'ha (regressione).
5. **Scoping MCP** — `buildDefaultMcpServers` include un server con
   `agents: ['god']` per god e lo esclude per un worker; un consenso senza
   `agents` si comporta esattamente come oggi (regressione); l'override di
   `command` è onorato per una entry `userConfigured` e ignorato per una che
   non lo è; una entry `userConfigured` senza `command` configurato viene
   esclusa invece di produrre un `mcpServers` rotto.

Più `npm run typecheck` pulito su node e web.

## Rischi accettati

- **La deduplica vive in un prompt, non in codice deterministico.** Un LLM
  esegue ogni 15 minuti la sequenza leggi-card → interroga-Jira → crea-issue. I
  paletti (aborto su JQL fallita, tetto per ciclo, `globalId` idempotente sul
  remote link) limitano il danno ma non lo eliminano. Il modo deterministico
  richiederebbe credenziali REST nel main process e il broker al posto
  dell'MCP: è la strada scartata consapevolmente con la decisione 7.
- **Il server MCP espone tool di scrittura.** `trello-mcp` non ha una modalità
  read-only né un allow-list di tool: god riceve anche `archive_list`,
  `create_board`, `update_card_details`. La sola-lettura è disciplina di
  prompt, non un vincolo tecnico. Mitigazione strutturale possibile in un
  lavoro separato: una modalità `TRELLO_READ_ONLY` nel repo
  `magenio-mcp/trello-mcp` che non registri affatto i tool di scrittura.
- **I nomi delle liste sono mutabili.** Rinominare una lista su Trello rompe il
  binding — ma rumorosamente: god riporta "lista non trovata sulla board X"
  invece di triaggiare in silenzio la lista sbagliata.
- **Il token Trello è fuori dal controllo dell'app** (vive nel `.env` del
  server MCP): non validabile, non ruotabile, non revocabile da munder-difflin.

## Fuori scope

- Qualunque scrittura verso Trello: commenti, spostamenti di card, etichette.
- Board Trello senza un progetto Jira dietro (conseguenza della decisione 3).
- Filtri sulle card per membro assegnato o per etichetta (decisione 5).
- Modifiche a `projectTag` e a `useResolvedRepoNames.ts` (decisione 10).
- La modalità read-only in `magenio-mcp/trello-mcp`: repo diverso, lavoro a
  parte.
- Verifica remota dell'esistenza di board e liste al salvataggio: si valida
  solo il formato.
- Un registro Trello autonomo e una UI multi-provider: l'estrazione da
  `shared/trelloIntake.ts` resta possibile e meccanica, ma non si fa ora.
