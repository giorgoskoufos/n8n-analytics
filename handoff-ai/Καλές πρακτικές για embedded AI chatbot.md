# Καλές πρακτικές για embedded AI chatbot

## Εκτελεστική σύνοψη

Για assistant μέσα σε κανονική σελίδα, η πιο πρακτική λύση είναι ένα **floating launcher** που ανοίγει ένα **μη-modal ή ελαφρά modal chat panel**, παραμένει διαθέσιμο σε όλες τις σελίδες και διατηρεί τη συνομιλία σε ξεχωριστό client-side state. Η απαίτηση είναι απολύτως εφικτή, αλλά η υλοποίηση εξαρτάται από το είδος της πλοήγησης: σε SPA το ίδιο DOM component μπορεί να παραμένει ζωντανό, ενώ σε κλασικό multi-page site χρειάζεται επαναδημιουργία του widget και επαναφόρτωση της κατάστασης από storage ή backend.

Το rendering πρέπει να ακολουθεί ασφαλή αλυσίδα: **μη αξιόπιστο Markdown → parser → allow-list sanitizer → DOM**, με ξεχωριστό code highlighter για fenced code blocks. Δεν πρέπει να εισάγεται ακαθάριστο HTML από το μοντέλο με `innerHTML`, ούτε να επιτρέπονται αυθαίρετα URLs, inline scripts, event handlers ή `javascript:` schemes. Η OWASP συνιστά context-specific encoding και sanitization με ώριμη βιβλιοθήκη αντί για custom regexes.[^1][^2]

## Προτεινόμενη αρχιτεκτονική

### Δομικά επίπεδα

Χώρισε το σύστημα σε πέντε ανεξάρτητα επίπεδα:

1. **Launcher**: μικρό floating button, με unread badge και accessible label.
2. **Shell**: header, minimize/close, conversation switcher, settings και panel sizing.
3. **Conversation view**: message list, streaming assistant message, citations/attachments και actions.
4. **Composer**: textarea, send, stop generation, attachments, voice προαιρετικά και keyboard behavior.
5. **Data layer**: conversation state, streaming transport, persistence, retry, telemetry και authentication.

Το widget δεν πρέπει να γνωρίζει τις λεπτομέρειες του backend. Το UI μπορεί να επικοινωνεί με ένα ενιαίο interface όπως `sendMessage()`, `stopGeneration()`, `loadConversation()` και `renderMessage()`. Έτσι μπορείς να ξεκινήσεις με vanilla JavaScript και αργότερα να μεταφέρεις το shell σε component χωρίς να ξαναγράψεις το πρωτόκολλο.

### SPA ή multi-page

| Μοντέλο | Τι συμβαίνει στην αλλαγή σελίδας | Καταλληλότητα |
|---|---|---|
| Κλασικό MPA, πλήρες reload | Το DOM και η σύνδεση χάνονται· το widget ξαναφορτώνεται | Εφικτό, αλλά χρειάζεται persistence και αποκατάσταση UI |
| SPA με History API/router | Το widget μένει mounted ενώ αλλάζει το content της σελίδας | Η καλύτερη εμπειρία για συνεχές chat |
| MPA με κοινό shell/server-side layout | Το ίδιο markup υπάρχει σε κάθε document· γίνεται hydrate από state | Καλός συμβιβασμός χωρίς πλήρες SPA |
| Widget σε iframe | Απομονωμένο UI, αλλά δυσκολότερη επικοινωνία και styling | Χρήσιμο για ανεξάρτητο/τρίτο σύστημα |

Σε SPA, κράτησε το `#assistant-root` έξω από το DOM container που αντικαθιστάς κατά την πλοήγηση. Αν χρησιμοποιείς Navigation API ή History API, άλλαζε μόνο το κύριο content και όχι το widget. Το View Transition API μπορεί να προσθέσει ομαλές μεταβάσεις σε SPA ή MPA, αλλά δεν είναι ο μηχανισμός persistence από μόνο του.[^3][^4][^5]

Σε MPA, η πιο αξιόπιστη συμπεριφορά είναι: αποθήκευση του conversation ID, των μηνυμάτων και του UI state, επαναφορά κατά το boot και επιστροφή στην ίδια θέση scroll. Το `beforeunload` δεν είναι λύση για κάθε αλλαγή σελίδας και πρέπει να χρησιμοποιείται μόνο για πραγματικά unsaved changes, επειδή μπορεί να επηρεάσει το back/forward cache.[^6]

## Floating widget και navigation

### Συνιστώμενο behavior

- Το launcher είναι σταθερό με `position: fixed`, `z-index` που τεκμηριώνεται και safe-area προσαρμογές για mobile.
- Το panel ανοίγει κοντά στον launcher σε desktop και γίνεται σχεδόν full-screen sheet σε μικρές οθόνες.
- Σε navigation, το chat δεν κλείνει χωρίς ενέργεια του χρήστη.
- Αν υπάρχει ενεργό streaming, η εφαρμογή δείχνει ότι η απάντηση συνεχίζεται ή προσφέρει «συνέχεια σε νέα σελίδα».
- Η συνομιλία περιλαμβάνει context της τρέχουσας σελίδας μόνο όταν είναι σκόπιμο, π.χ. `pageUrl`, `pageTitle`, selected entity και tenant, όχι ολόκληρο το DOM.
- Το widget δεν καλύπτει primary controls και δεν εμποδίζει την ανάγνωση της σελίδας όταν είναι κλειστό.

### Persistence strategy

Κράτησε στον client μόνο ό,τι χρειάζεται για γρήγορο restore:

```js
const uiState = {
  open: true,
  activeConversationId: "conv_123",
  draft: "",
  panelSize: "normal",
  lastRoute: location.pathname,
  scrollTop: 842
};

localStorage.setItem("assistant-ui", JSON.stringify(uiState));
```

Για μικρό draft και βασικές προτιμήσεις αρκεί `localStorage`. Για πολλά conversations, μεγάλα messages, attachments ή offline queue χρησιμοποίησε IndexedDB. Η authoritative ιστορία πρέπει να βρίσκεται στον server, ώστε ο χρήστης να μπορεί να συνεχίσει από άλλη συσκευή και να υπάρχει retention/deletion policy.

Για tabs ή παράθυρα του ίδιου origin, το `BroadcastChannel` μπορεί να συγχρονίζει events όπως `message-added`, `conversation-updated` και `logout` μεταξύ browsing contexts. Μην θεωρείς το channel μηχανισμό ασφάλειας: όλα τα μηνύματα πρέπει να αντιμετωπίζονται ως data και να επικυρώνονται.[^7][^8]

## Input UX

### Composer

Χρησιμοποίησε `<form>` με `<textarea>` και σαφές submit button. Το Enter μπορεί να στέλνει σε desktop μόνο αν η εφαρμογή το δηλώνει ξεκάθαρα· το `Shift+Enter` πρέπει να εισάγει νέα γραμμή. Σε mobile, μην βασίζεσαι σε key events για αποστολή.

Ο composer πρέπει να υποστηρίζει:

- disabled state όσο απαιτείται, αλλά όχι όσο γίνεται streaming αν επιτρέπεται νέο μήνυμα·
- stop/cancel button κατά τη δημιουργία·
- validation για κενό input, μέγιστο μήκος και attachments·
- draft persistence ανά conversation·
- paste εικόνας ή αρχείου με εμφανές όριο τύπου/μεγέθους·
- retry του τελευταίου failed message·
- σαφή error χωρίς απώλεια του κειμένου·
- IME-safe handling για ελληνικά, κινέζικα και ιαπωνικά, ώστε να μην αποστέλλεται μήνυμα στη μέση composition event.

Μην μετατρέπεις κάθε πληκτρολόγηση σε request προς το LLM. Κάνε submit όταν ο χρήστης ολοκληρώσει, και βάλε debounce μόνο σε autocomplete ή search. Το input πρέπει να είναι ειλικρινές ως προς τις δυνατότητες: placeholder όπως «Ρώτησε για…» και σύντομο scope στο πρώτο μήνυμα είναι καλύτερα από υπόσχεση ότι ο assistant γνωρίζει τα πάντα. Η διαφάνεια για την ταυτότητα και το scope βοηθά την εμπιστοσύνη σε conversational interfaces.[^9][^10]

## Output rendering

### Markdown pipeline

Προτεινόμενη ροή:

```text
model text
  -> parse Markdown
  -> allow-list sanitize generated HTML
  -> attach safe event handlers
  -> render into message container
  -> post-process code blocks and media
```

Για vanilla JavaScript, ένας πρακτικός συνδυασμός είναι `marked` ή άλλος ώριμος Markdown parser, `marked-highlight`/`highlight.js` για fenced code και `DOMPurify` για sanitization. Το `marked-highlight` υποστηρίζει μετασχηματισμό code blocks με language prefix και fallback σε `plaintext` όταν η γλώσσα δεν αναγνωρίζεται. Το `marked` τεκμηριώνει επίσης τη δυνατότητα custom highlighter και synchronous/asynchronous parsing.[^11][^12]

Ενδεικτική αρχή υλοποίησης:

```js
const renderer = new marked.Renderer();

marked.use(markedHighlight({
  langPrefix: "hljs language-",
  highlight(code, lang) {
    const language = hljs.getLanguage(lang) ? lang : "plaintext";
    return hljs.highlight(code, { language }).value;
  }
}));

function renderMarkdown(source, target) {
  const unsafeHtml = marked.parse(source);
  const safeHtml = DOMPurify.sanitize(unsafeHtml, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
    FORBID_ATTR: ["style", "onerror", "onclick"]
  });
  target.replaceChildren();
  target.insertAdjacentHTML("beforeend", safeHtml);
}
```

Το παράδειγμα είναι αφετηρία και όχι πλήρης security policy. Οι allowed tags/attributes/URL schemes πρέπει να περιοριστούν στις πραγματικές ανάγκες του προϊόντος, να δοκιμάζονται με malicious payloads και να ενημερώνεται η βιβλιοθήκη. Η CSP με Trusted Types μπορεί να περιορίσει sinks όπως `innerHTML` και να απαιτεί typed, sanitized HTML values.[^13]

### Code blocks

Κάθε block κώδικα πρέπει να εμφανίζει:

- language label, με `plaintext` fallback·
- copy button με feedback «Αντιγράφηκε»·
- οριζόντιο scroll αντί για wrapping σε κώδικα·
- line wrapping ως προαιρετική ρύθμιση·
- accessible name και keyboard operation·
- download ή «open in editor» μόνο αν υπάρχει ασφαλής, σαφής ροή·
- σταθερό font και theme που λειτουργεί σε light/dark mode.

Μην κάνεις execute τον κώδικα που εμφανίζει το μοντέλο μέσα στο browser. Αν χρειάζεται εκτέλεση, χρησιμοποίησε απομονωμένο backend/sandbox με resource limits, network policy, timeout και ξεκάθαρη επιβεβαίωση.

### Ειδικά blocks

Υποστήριξε με typed message parts και όχι μόνο με ένα μεγάλο HTML string:

```js
{
  type: "assistant_message",
  parts: [
    { type: "markdown", source: "..." },
    { type: "code", language: "sql", source: "SELECT 1;" },
    { type: "image", url: "https://cdn.example.com/a.png", alt: "..." },
    { type: "citation", title: "Documentation", url: "https://..." },
    { type: "tool_result", label: "Query result", data: [] }
  ]
}
```

Αυτό διευκολύνει διαφορετικό rendering για Markdown, code, εικόνες, charts, citations, tables και tool results. Επιτρέπει επίσης να διατηρείται raw source για edit/copy/export χωρίς να γίνεται reverse-engineering από HTML.

Για εικόνες, έλεγξε scheme, origin ή allow-list CDN, χρησιμοποίησε `alt`, lazy loading και placeholder/error state. Μην επιτρέπεις ανεξέλεγκτα `data:` URLs ή remote HTML/iframes. Για links, άνοιγμα σε νέο tab πρέπει να χρησιμοποιεί κατάλληλο `rel` και να επιτρέπονται κατά προτίμηση μόνο `https` URLs.[^14][^1]

## Streaming output

Το streaming είναι σημαντικό για perceived latency: ο χρήστης βλέπει την αρχή της απάντησης πριν ολοκληρωθεί όλο το output. Τα SSE streams είναι one-way από server προς browser, ενώ WebSockets υποστηρίζουν αμφίδρομη interactive σύνδεση.[^15][^16][^17]

Για απλό assistant με user request και server-generated tokens, SSE πάνω από `fetch` ή EventSource είναι συχνά αρκετό. Το πρωτόκολλο πρέπει να έχει typed events, για παράδειγμα:

```text
message.started
message.delta
message.annotation
message.completed
message.failed
message.cancelled
```

Μην κάνεις πλήρες reparse και re-render ολόκληρου του conversation σε κάθε token. Κράτησε έναν streaming buffer για το ενεργό μήνυμα, κάνε batching των deltas και re-render ανά μικρό χρονικό διάστημα. Το τελικό μήνυμα πρέπει να αποθηκεύεται μόνο όταν ληφθεί `completed`, ενώ σε disconnect πρέπει να υπάρχει retry ή σαφής κατάσταση incomplete.

Κατά τη διάρκεια streaming, μην ανακοινώνεις κάθε token σε screen reader. Δείξε οπτικό progress και χρησιμοποίησε ξεχωριστό `role="status"` για «Ο assistant γράφει» και «Η απάντηση ολοκληρώθηκε». Το `role="status"` έχει implicit polite live behavior, ενώ το `role="log"` είναι κατάλληλο για διαδοχικές ενημερώσεις ιστορικού chat.[^18][^19]

## Accessibility

### Dialog και focus

Αν το panel μπλοκάρει την υπόλοιπη σελίδα, αντιμετώπισέ το ως dialog. Αν είναι non-blocking floating panel, μην προσποιείται ότι είναι modal. Σε modal mode απαιτούνται accessible name, Escape για κλείσιμο, ορατό close button, σωστή διαχείριση Tab και επιστροφή focus στο launcher. Η WCAG 2.2 απαιτεί keyboard operability και no keyboard trap, ενώ το focus πρέπει να παραμένει ορατό και όχι πλήρως καλυμμένο από author-created content.[^20][^21][^22]

Ενδεικτική σήμανση:

```html
<button id="assistant-launcher"
        aria-controls="assistant-panel"
        aria-expanded="false"
        aria-label="Άνοιγμα assistant">
  <span aria-hidden="true">✦</span>
</button>

<section id="assistant-panel"
         role="dialog"
         aria-modal="false"
         aria-labelledby="assistant-title"
         hidden>
  <h2 id="assistant-title">Assistant</h2>
  <button type="button" aria-label="Κλείσιμο assistant">×</button>
  <div id="chat-log" role="log" aria-labelledby="assistant-title"></div>
  <div id="chat-status" role="status" aria-live="polite"></div>
</section>
```

Το `aria-modal="true"` δεν πρέπει να χρησιμοποιείται απλώς επειδή υπάρχει floating UI. Χρησιμοποίησέ το μόνο όταν πράγματι εμποδίζεται η αλληλεπίδραση με το background και το background γίνεται inert. Η Material guidance επίσης προτείνει dialogs να χρησιμοποιούνται φειδωλά και να μη μπλοκάρουν μη κρίσιμη πληροφορία.[^23]

### Οπτική προσβασιμότητα

- Contrast τουλάχιστον WCAG AA για κείμενο και controls.
- `:focus-visible` με ισχυρό, μη χρονικά περιορισμένο focus ring.
- Δεν βασίζεσαι μόνο στο κόκκινο/πράσινο για error/success· πρόσθεσε icon, label ή text.
- Σεβασμός σε `prefers-reduced-motion`, `forced-colors`, zoom και text resizing.
- Touch targets αρκετά μεγάλα και με απόσταση μεταξύ τους.
- `alt` για meaningful images και κενό alt για decorative images.
- Μην κάνεις auto-scroll αν ο χρήστης έχει ανέβει χειροκίνητα στο ιστορικό· εμφάνισε «Νέα μηνύματα» button.

## Security και privacy

Το prompt/input validation δεν αντικαθιστά output security. Αν ο χρήστης ή το μοντέλο μπορεί να επηρεάσει Markdown, HTML, URLs, filenames ή tool arguments, η εφαρμογή πρέπει να κάνει validation σε κάθε boundary. Η OWASP τονίζει ότι το encoding είναι context-specific και ότι untrusted data δεν πρέπει να μπαίνει σε executable contexts.[^24][^1]

Βασικές δικλίδες:

- API keys μόνο στον server, ποτέ σε vanilla client bundle.
- Authentication και authorization σε κάθε conversation/tool request.
- Tenant isolation και object-level authorization για conversation IDs.
- Rate limits, quotas, max prompt/output size και abuse protection.
- CSRF protection όπου χρησιμοποιούνται cookies.
- CSP, `frame-ancestors`, secure cookies, `Referrer-Policy` και HTTPS.
- Redaction ή minimization για προσωπικά δεδομένα και ευαίσθητο page context.
- Retention policy, delete/export controls και ενημέρωση για το αν τα δεδομένα χρησιμοποιούνται για training.
- Audit logs για tool calls, όχι απαραίτητα πλήρες raw content αν περιέχει προσωπικά δεδομένα.
- Server-side validation όλων των tool arguments και confirmation πριν από destructive actions.

Ιδιαίτερη προσοχή χρειάζεται στο prompt injection από περιεχόμενο της σελίδας, αρχεία ή retrieved documents. Η σελίδα δεν πρέπει να μπορεί να δώσει στον assistant ανεξέλεγκτη εντολή για αποστολή email, αλλαγή δεδομένων ή διαρροή secret. Τα εργαλεία πρέπει να έχουν ελάχιστα δικαιώματα και explicit confirmation για side effects.

## Performance και reliability

Κάνε lazy-load το Markdown parser, highlighter και βαριά icon/attachment modules όταν ανοίγει ο assistant. Κράτησε μικρό το αρχικό bundle και μη φορτώνεις όλες τις γλώσσες του highlight.js αν χρειάζεσαι μόνο JavaScript, TypeScript, SQL, JSON, HTML, CSS, Python και Bash.

Υποστήριξε abort με `AbortController`, exponential backoff μόνο για retryable failures, idempotency key ανά submit και deduplication ώστε διπλό click να μη δημιουργεί δύο απαντήσεις. Τα states πρέπει να είναι explicit: `idle`, `sending`, `streaming`, `completed`, `failed`, `cancelled`, `offline`.

Για offline συμπεριφορά, μπορείς να αποθηκεύεις drafts και cached conversation metadata, αλλά μην παρουσιάζεις τον assistant ως διαθέσιμο όταν δεν υπάρχει σύνδεση. Web manifest και service worker μπορούν να κάνουν την εφαρμογή installable και να προσφέρουν offline εμπειρία, αλλά το service worker δεν πρέπει να cache-άρει ευαίσθητες απαντήσεις χωρίς σαφή πολιτική.[^25][^26]

## Observability και product UX

Κατέγραψε metrics που μετρούν task completion, όχι μόνο αριθμό messages:

- time to first token και time to completed response·
- streaming disconnect/error rate·
- retry/cancel rate·
- rate χρήσης suggested prompts·
- no-answer ή escalation rate·
- copy-code και citation click rate·
- conversation continuation μετά από navigation·
- feedback ανά απάντηση·
- κόστος tokens και tool latency ανά route/tenant.

Κάθε απάντηση πρέπει να έχει feedback controls, copy, retry και — όπου ταιριάζει — «αναφορά προβλήματος». Δείξε πότε χρησιμοποιήθηκε knowledge base, tool ή page context. Η διαφάνεια, το προφανές scope και ορατή δυνατότητα handoff μειώνουν το αίσθημα ότι ο χρήστης παγιδεύτηκε σε bot.[^27][^10]

## Checklist υλοποίησης

### MVP

- Floating launcher με responsive panel.
- Conversation state και restore μετά από reload.
- Vanilla form με textarea, Enter/Shift+Enter και stop.
- SSE ή fetch streaming με cancel και retry.
- Markdown parser + sanitizer + code highlighting.
- Copy code, links, images με alt και error states.
- Keyboard navigation, focus return, `role="log"` και `role="status"`.
- Server-side auth, rate limiting και API key isolation.

### Production hardening

- IndexedDB για μεγαλύτερη local cache και drafts.
- Server persistence με delete/export/retention policy.
- CSP/Trusted Types και security tests για XSS/URL payloads.
- Typed message parts και typed streaming events.
- Page context contract αντί για αυθαίρετο DOM scraping.
- Tool permissions, confirmation και audit logs.
- Mobile keyboard/safe-area testing.
- Screen-reader testing με NVDA/VoiceOver/TalkBack.
- Test navigation κατά τη διάρκεια streaming, offline transition, duplicate submit και browser back-forward cache.
- Product analytics με privacy-preserving aggregation.

## Προτεινόμενη τελική επιλογή

Για το συγκεκριμένο stack, προτείνεται **shared assistant shell + vanilla JavaScript state store**, με το shell να μένει έξω από το route content. Αν μπορεί να υιοθετηθεί SPA-style navigation, κράτησε ένα μόνιμο DOM instance. Αν το site παραμείνει MPA, χρησιμοποίησε κοινό partial σε κάθε σελίδα και επαναφορά από server conversation plus local draft/UI state.

Στο rendering, κράτησε ως canonical data το typed message model και όχι το παραγόμενο HTML. Για Markdown χρησιμοποίησε parser, highlighter και sanitizer ως τρία ξεχωριστά βήματα. Για το UX, δώσε προτεραιότητα σε σταθερό panel, σωστό streaming, code blocks, ασφαλή links/images, scroll που δεν «κλέβει» τον χρήστη και πλήρη keyboard/screen-reader συμπεριφορά. Αυτή η προσέγγιση προσφέρει εμπειρία παρόμοια με embedded assistants όπως ChatGPT ή Claude, χωρίς να μετατρέπεται ολόκληρη η σελίδα σε dedicated chat εφαρμογή.

---

## References

1. [www-projectchapter-example/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.md at main · OWASP/www-projectchapter-example](https://github.com/OWASP/www-projectchapter-example/blob/main/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.md) - Contribute to OWASP/www-projectchapter-example development by creating an account on GitHub.

2. [Cross Site Scripting Prevention Cheat Sheet](https://github.com/nokia/OWASP-CheatSheetSeries/blob/master/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.md) - The SanitizeHelper module provides a set of methods for scrubbing text of undesired HTML elements. F...

3. [View Transition API - MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) - The View Transition API provides a mechanism for easily creating animated transitions between differ...

4. [Navigation API - a better way to navigate, is now Baseline Newly ...](https://web.dev/blog/baseline-navigation-api) - The Navigation API is now Baseline Newly available, providing a better way to handle navigation in s...

5. [View transitions for single page applications](https://web.dev/learn/css/view-transitions-spas) - View Transitions give you a way to show continuity or context between the pages in your SPA. changin...

6. [Window: beforeunload event - Web APIs | MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event) - The beforeunload event is fired when the current window, contained document, and associated resource...

7. [BroadcastChannel - Web APIs | MDN](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel) - The BroadcastChannel interface represents a named channel that any browsing context of a given origi...

8. [Broadcast Channel API - MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/Broadcast_Channel_API) - The Broadcast Channel API allows basic communication between browsing contexts (that is, windows, ta...

9. [The User Experience of Chatbots - Nielsen Norman Group | PDF](https://www.slideshare.net/slideshow/the-user-experience-of-chatbots-nielsen-norman-group/124744299) - This document summarizes guidelines for designing effective chatbots. It discusses findings from a s...

10. [conversational interfaces Articles & Videos - Nielsen Norman Group](https://www.nngroup.com/topic/conversational-interfaces/)

11. [markedjs/marked-highlight: Add code highlighting to marked](https://github.com/markedjs/marked-highlight) - Add code highlighting to marked. Contribute to markedjs/marked-highlight development by creating an ...

12. [marked/README.md at master · mattermost/marked](https://github.com/mattermost/marked/blob/master/README.md) - A markdown parser and compiler. Built for speed. Contribute to mattermost/marked development by crea...

13. [Content-Security-Policy: require-trusted-types-for directive](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/require-trusted-types-for) - The HTTP Content-Security-Policy (CSP) require-trusted-types-for directive instructs user agents to ...

14. [CheatSheetSeries/cheatsheets/HTML5_Security_Cheat_Sheet.md at master · OWASP/CheatSheetSeries](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/HTML5_Security_Cheat_Sheet.md) - The OWASP Cheat Sheet Series was created to provide a concise collection of high value information o...

15. [Streaming API responses](https://developers.openai.com/api/docs/guides/streaming-responses) - Learn how to stream model responses from the OpenAI API using server-sent events.

16. [Using server-sent events - Web APIs | MDN](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) - You'll need a bit of code on the server to stream events to the front-end, almost identically to web...

17. [WebSocket API (WebSockets) - Web APIs - MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) - The WebSocket API makes it possible to open a two-way interactive communication session between the ...

18. [ARIA22: Using role=status to present status messages | WAI](https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA22)

19. [Using role=log to identify sequential information updates](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA23)

20. [Web Content Accessibility Guidelines (WCAG) 2.2](https://www.w3.org/TR/WCAG22/) - If keyboard focus can be moved to a component of the page using a keyboard interface, then focus can...

21. [What's New in WCAG 2.2 | Web Accessibility Initiative (WAI) - W3C](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/) - This page lists the new success criteria in Web Content Accessibility Guidelines (WCAG) 2.2. It incl...

22. [Understanding SC 2.4.11: Focus Not Obscured (Minimum) ...](https://www.w3.org/WAI/WCAG22/Understanding/focus-not-obscured-minimum.html) - The intent of this success criterion is to ensure that the item receiving keyboard focus is always p...

23. [Dialogs – Material Design 3](https://m3.material.io/components/dialogs/accessibility) - Dialogs provide important prompts in a user flow. Use dialogs to make sure users act on information

24. [Cross Site Scripting (XSS)](https://owasp.org/www-community/attacks/xss/) - The primary defenses against XSS are described in the OWASP XSS Prevention Cheat Sheet. Also, it's c...

25. [Making PWAs installable - Progressive web apps | MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable) - One of the defining aspects of a PWA is that it can be promoted by the browser for installation on t...

26. [CycleTracker: Service workers - Progressive web apps | MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Tutorials/CycleTracker/Service_workers) - Thus far, we've written the HTML, CSS, and JavaScript for CycleTracker. We added a manifest file def...

27. [Nielsen Norman Group publishes practical chatbot design ...](https://ultimatedesigntools.com/blog/wire-nng-chatbot-guidelines/) - NN/g released a new set of usability guidelines for chatbots this week, covering scope-setting, conv...

