# Modello decisionale locale per Munder Difflin

**Stato:** proposta differita; nessuno sviluppo avviato o pianificato per ora.

**Data:** 14 ottobre 2026.

**Decisioni già prese:** i dati restano sempre in locale; sono interessanti assegnazione dei task, controllo delle azioni e verifica dei risultati; una futura prima versione può applicare automaticamente solo decisioni a rischio limitato.

## Obiettivo

Valutare un modello che scelga fra opzioni definite da Munder, invece di generare testo, per ridurre il lavoro ripetitivo di coordinamento della flotta. Il risultato utile è un task completato correttamente con meno tempo, costo e interventi umani; la velocità della singola risposta del modello non basta a dimostrarlo.

Il modello decisionale non diventa un `AgentProvider` né sostituisce God o gli agenti che svolgono il lavoro. Riceve uno stato sintetico, un insieme chiuso di candidati e una domanda precisa. Munder valida la risposta e decide quali effetti può avere.

## Contesto nella repo

- `src/main/hive.ts` mantiene registro degli agenti, messaggi e task; `src/main/index.ts` gestisce le richieste di avvio dei worker e la cronologia dei task.
- `src/shared/agentProvider.ts` descrive le capacità dei provider conversazionali. Un modello decisionale avrebbe un ruolo diverso e andrebbe tenuto fuori da questo catalogo.
- `src/main/breaker.ts`, `src/main/control.ts`, `src/main/hooks.ts` e `src/main/workerWake.ts` applicano già regole per budget, pause, permessi e risveglio dei worker. Queste regole restano autoritative.
- La classificazione della posta usa già un modello locale opzionale (`src/main/mail/localModel.ts`) con regole di routing prioritarie (`src/shared/mail.ts`). È un precedente utile per confini e fallback locali; il modello decisionale non ne sostituirebbe la generazione di riepiloghi.

## Dove può essere utile

| Decisione | Prima applicazione sensata | Limite dell'automazione |
| --- | --- | --- |
| Assegnazione dei task | Scegliere un agente esistente e idoneo fra candidati dello stesso progetto, oppure rimettere il task a God | Solo lavoro già autorizzato, entro budget e con stato della flotta aggiornato; niente nuove assunzioni automatiche nella prima versione |
| Controllo delle azioni | Segnalare un'azione anomala o chiedere una revisione | Il modello non concede permessi e non supera i blocchi deterministici o le richieste di approvazione umana |
| Verifica del risultato | Indicare un completamento che merita ulteriore controllo | Il modello non marca un task come completato e non sostituisce prove, controlli o revisione umana |

La prima applicazione proposta è **l'assegnazione di task a un agente già presente**. È una scelta circoscritta, ha dati disponibili nella flotta e permette di osservare riassegnazioni, esiti e costi. Controllo delle azioni e verifica dei risultati seguono solo se emergono esempi etichettati e un vantaggio misurato; in particolare non si inserisce una chiamata al modello davanti a ogni tool.

## Modelli e modalità locali

**Jev** è un riferimento per l'interfaccia a scelte, punteggi e probabilità, ma la sua integrazione documentata passa da un'API ospitata. Con il vincolo locale non è un backend candidabile per Munder. [Annuncio TypeSafe](https://typesafe.ai/blog/introducing-system-one-models-and-jev) · [API TypeSafe](https://api.typesafe.ai/redoc).

**CLM-v0.1-8B** è un candidato sperimentale locale, con pesi Apache 2.0. Confronta lo stato con azioni candidate e non genera testo. Richiede l'encoder Qwen3-8B e le proprie teste di proiezione; le probabilità sono relative alle opzioni presentate. I risultati di verifica del codice pubblicati dagli autori usano teste addestrate per quei benchmark, non il checkpoint generale senza adattamento. [Scheda del modello](https://huggingface.co/Contrastive-LM/CLM-v0.1-8B) · [codice e modalità di esecuzione](https://github.com/Contrastive-LM/CLM).

Sul Mac M1 Max con 32 GB usato oggi per Munder, un port MLX per Apple Silicon rende plausibile una prova locale. È un port della comunità, non degli autori di CLM; la sua scheda riporta circa 8 GB su disco e 9 GB di memoria di picco misurati su un M3 Pro, non prestazioni garantite su questo Mac o mentre altri agenti sono attivi. Non va incluso automaticamente nell'installer dell'app prima di misurare memoria, tempi e compatibilità. [Port MLX e misure](https://huggingface.co/mlx-community/CLM-v0.1-8B-MLX-8bit).

L'alternativa da confrontare è un piccolo modello generativo **già locale** che restituisca scelte strutturate. Serve come baseline: se fornisce gli stessi esiti con meno complessità operativa, CLM non aggiunge valore sufficiente. Un runtime CLM incorporato direttamente nell'app sarebbe più impegnativo da distribuire e aggiornare; per una prima valutazione è preferibile un servizio locale opzionale raggiungibile solo su loopback, senza fallback remoto.

## Prima versione proposta

1. Munder costruisce un insieme di candidati **prima** della chiamata al modello: agenti esistenti, associati al progetto e disponibili, con capacità pertinenti e budget residuo. Le regole escludono agenti in pausa, bloccati o con stato non affidabile. `God` e `nessuna assegnazione` sono sempre opzioni valide.
2. Un servizio decisionale locale riceve soltanto l'obiettivo necessario al routing e dati sintetici dei candidati. La risposta contiene una scelta fra gli ID ammessi e un punteggio. Testo del task e opzioni restano dati, mai istruzioni capaci di cambiare le regole di Munder.
3. Munder valida tipo, candidato, stato aggiornato e budget. Un errore, un timeout, una scelta non ammessa o un'incertezza superiore alla soglia riportano il task a God. La soglia si determina sui dati reali di Munder: il punteggio grezzo non è un'autorizzazione.
4. In **shadow mode**, Munder registra la scelta senza applicarla e la confronta con l'assegnazione effettiva. Dopo una valutazione soddisfacente, un'opzione esplicita può abilitare l'assegnazione automatica dei soli task già autorizzati a un agente esistente: aggiorna la card e recapita una sola volta l'ordine tramite l'inbox già in uso. Un registro locale conserva ID del task, modello/versione, candidati, punteggio ed esito senza duplicare il testo del task; l'operazione deve essere idempotente e riassegnabile.

L'automazione iniziale riguarda solo il routing e il recapito di lavoro già autorizzato. Non avvia worker, non concede accesso a MCP o tool, non cambia i limiti di spesa e non certifica il completamento.

## Come decidere se vale la pena svilupparlo

Preparare un insieme rappresentativo di task storici, separando i casi usati per scegliere soglie da quelli usati per giudicare il risultato. Confrontare regole attuali/God, modello locale generativo e CLM sugli stessi stati e candidati. Poi osservare il comportamento in shadow mode su task nuovi.

Le metriche principali sono task completati correttamente, riassegnazioni, interventi umani, costo e tempo **per task completato**. Per l'automazione servono anche falsi instradamenti, comportamento su casi ambigui, calibrazione dei punteggi, RAM e latenza con la flotta attiva. Un modello che risponde più in fretta ma peggiora completamento o recupero non passa alla fase automatica. In uno [studio empirico su Jev](https://arxiv.org/abs/2610.13092), risparmi sulla singola decisione non si sono tradotti uniformemente in migliori esiti dei workflow.

La verifica generica dei risultati richiede una valutazione distinta: uno [studio indipendente su CLM-v0.1-8B come giudice](https://arxiv.org/abs/2610.07177) ha trovato prestazioni vicine al caso su diversi benchmark pubblici e punteggi grezzi troppo sicuri. Questo non misura il routing dei task di Munder, ma impedisce di assumere che il checkpoint generale sia già un verificatore affidabile.

## Questioni da riprendere quando partirà il lavoro

- Quali origini di task sono già autorizzate all'assegnazione automatica e quali richiedono sempre God o una persona?
- Quali campi del registro agenti rappresentano capacità e disponibilità con affidabilità sufficiente, e quanto recente deve essere lo stato?
- Quale runtime locale mantenere su macOS, Windows e Linux, e quali requisiti minimi di memoria rendere espliciti?
- Quali esempi reali etichettare e quali soglie di errore accettare prima di abilitare l'automazione?

**Prossimo passo, quando richiesto:** scegliere il perimetro dei task candidati e svolgere una valutazione locale comparativa. Solo dopo i risultati preparare un piano di implementazione. Nessuna dipendenza, servizio o modifica al prodotto è prevista da questa proposta.
