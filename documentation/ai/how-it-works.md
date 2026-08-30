# How the assistant works

*For anyone who runs n8n and uses this dashboard. No code, no setup — this is
about what you can ask it, what it will refuse, and when to believe it.*

---

## What it is

A chat panel on every page of the dashboard that answers questions about **your
n8n instance**: how much ran, what failed, what is slow, what stopped running,
what a particular execution did.

It reads the dashboard's own local replica of your n8n database — the same copy
every chart on every page is drawn from. It never touches your production n8n
while answering, so asking it a hard question cannot slow down your automations.

---

## The one idea worth understanding

**The model does not write database queries. It chooses from a menu.**

That sounds like a limitation, and it is one. It is also the reason the numbers
can be trusted.

A general "chat with your database" tool works by having the model invent SQL,
run it, and describe the result. When the SQL is subtly wrong — the wrong time
window, the wrong workflow, a join that double-counts — the description of the
wrong answer is just as fluent and confident as the description of a right one.
You cannot tell from reading it.

Here, the model picks one of twenty pre-written analyses. Each of them was
written once, is used by the dashboard's own pages, and is covered by tests.
The model chooses *which* analysis and *what to narrow it to*; it does not get
to decide what "error rate" means. When it picks the wrong analysis, you usually
get an answer to a different question rather than a wrong answer to yours — and
that is a much easier mistake to notice.

---

## What you can ask

Phrase things normally. The grouping below is what is behind the scenes, not a
syntax you have to learn.

### How are things going

- *"How is the instance doing this week?"*
- *"How is CallCenterPerMinute doing?"*
- *"Compare this week against last week."*
- *"When did traffic change?"*

A quiet period is reported as a real zero, not as missing data — this matters,
because "nothing ran" and "we have no records" are very different problems.

### What is failing

- *"What is the most serious problem right now?"*
- *"Which workflows fail most, and with what?"*
- *"Are webhook failures different from schedule failures?"* — they usually are,
  and it can split them.
- *"Is this failure a one-off or does it happen often?"*

It also knows about **retries**: a workflow that fails and then succeeds on
retry is not as broken as its raw error count suggests, and there is an analysis
that says so.

### What is slow, and where the time goes

- *"Which workflows are slowest?"*
- *"Why is that one slow? Where does the time go?"* — this goes node by node.
- *"Is the queue keeping up?"* — queue lag, which is a different question from
  "is anything failing". A queue can be badly behind with a zero error rate.
- *"How many executions ran at the same instant at peak?"* — genuinely different
  from how many *started*, and a much smaller number.

### What stopped without complaining

- *"Is there a workflow that stopped running without erroring?"*

This is the one most people do not think to ask. A workflow that fails is loud;
a workflow that silently stopped triggering is invisible. The assistant learns
each workflow's normal cadence and reports how many times over it is.

### Structure and change

- *"How is the folder X doing?"* / *"...workflows tagged Y?"*
- *"What breaks if this credential expires?"* — what depends on it, and how
  healthy those dependants are.
- *"Did something change just before the errors started?"* — saved workflow
  versions, with the error rate either side of each.

### Cost

- *"How much space is execution data taking, and where is it heading?"*
- *"How much time have we saved?"* — see the caveat under
  [ROI](#roi-is-only-as-good-as-what-you-configured).

### One specific thing

- *"What happened in execution 1031470?"* — node by node, with timings.
- *"Why did it fail?"* — which node, which category.

### How n8n itself works

If your dashboard has the n8n documentation connected (Settings → Integrations),
you can also ask *"what do the docs say about configuring retries on an HTTP
Request node?"* and get an answer from the official documentation rather than a
guess.

Two rules were deliberately locked in here:

- **The docs are a source, not an authority.** If the documentation and your own
  measurements disagree, your measurements win.
- **Your workflow and folder names are never sent to the documentation service.**
  Names describe your business, and that is an external service.

---

## What it will not answer, and why

**Customer data that passed through a workflow.** Not "will not" as a policy —
the data is not reachable. The views the assistant reads do not contain the
payload columns at all, so a request for them fails at the database rather than
being declined by a rule someone could change or forget.

**Anything about workflows you cannot see.** If your n8n account only has access
to some projects, the assistant sees exactly those. This is not a filter applied
to the answer at the end; it is built into every query before it runs. n8n owners
and admins see everything, because in n8n they already can.

**Business outcomes.** The replica holds executions, not revenue. Asked how much
money the workflows made, the honest answer is that the data is not there — and
saying so is the correct answer, not a failure.

---

## Pointing at something specific

Two shortcuts, both optional.

### `@` — point at a thing

Type `@` in the chat box and pick from the list. It covers workflows, folders,
tags, projects, node types, error groups and executions.

```
how is @workflow:CallCenterPerMinute doing?
why did @execution:1031787 fail?
```

Worth knowing: **names on a real instance are not unique.** On the instance this
was built against, three separate workflows are called "Saved Messages v2" and
five other names are duplicated — which is ordinary, not sloppy. That is why the
picker puts the *id* into your message and shows you the *name* on the chip, so
there is never a question about which one you meant. If you type an ambiguous
name by hand, it tells you which ones matched instead of guessing.

A chip that turns **red** means it could not be resolved — usually a name that
does not exist, or one outside what you are allowed to see. The assistant says
so in its answer rather than quietly answering about something else.

### `+` — choose the tools

The `+` button next to the chat box lets you turn things off for a question, and
lets you force the documentation lookup on. `@tool:docs` in your message forces
it too, regardless of the toggle.

---

## Conversations and memory

**Conversations are separate threads.** This matters more than it sounds. If one
endless thread held everything, asking about queue lag on Monday and error rates
on Thursday would mean Thursday's answer arrives with Monday's table still in
view — and a model handed an unrelated earlier result does not ignore it, it
tries to reconcile it. Start a new conversation when you change subject.

**Within a conversation it reads the whole thread — and what it did.** Every
earlier question and answer, plus, beside each answer, the list of analyses that
produced it. So "and its errors?" works: it already has the workflow, because
the previous turn's own record says which one it measured.

This replaced a summary. Older messages used to be compressed into a paragraph
of notes, which kept long threads cheap and quietly lost two things — the actual
words, which were the only part of the context you could check, and the record
of which analysis produced which number, which the summariser never read at all.
The visible symptom was an assistant that could remember what it had *said* and
not what it had *looked at*, so it re-identified the same workflow on every
follow-up, and occasionally answered about the whole instance while using the
workflow's name.

A thread long enough to exceed what can be sent is cut at the front, at a whole
question, and the assistant is told it was cut — so it says the start of the
conversation is not visible rather than answering as though the thread began in
the middle.

**Threads name themselves from what they turned out to be about.** After the
first answer, the assistant writes a short title from the opening question *and*
that answer — "Call Center overnight failures", not "why did the CallCenterPer…".
The answer is in the input on purpose: "is anything broken?" has no subject until
something answers it, and a name taken from the question alone can only restate
the question.

It happens once, at the start of a thread, and never again. A conversation that
kept renaming itself would be one you could not find again the next morning. If
you rename a thread yourself, that is final — the assistant will not improve it
back.

**Memory is different: it crosses conversations.** If you tell it something
about how you work — *"I look after the Call Center folder"*, *"always give me
absolute numbers next to percentages"* — it can keep a one-line note, and a
brand new conversation will already know it.

Three things about memory that are deliberate:

- **It only writes one when you tell it something.** There is no background
  process reading your questions and drawing conclusions about you. A note about
  someone written from a moment they were not present for is a file, not a
  memory.
- **You can see and delete every note**, in Settings → Assistant memory. That is
  the condition on the feature existing, not a nicety.
- **A memory changes how it answers, never what it measures.** A note saying you
  look after one folder must not turn "how is the instance doing" into "how is
  your folder doing". This one was got wrong once and fixed: it was answering
  instance-wide questions about a single folder, silently, and the number looked
  just as authoritative.

---

## How to check an answer

Under every answer there is **"How this was worked out"**. Open it. It lists
every analysis that was run and what it was narrowed to — for example
`get_analytics: kpis · workflow 6v295G18HhxEYZe9`.

That line is the answer to *"is this number about the thing I asked about?"* —
which is the question worth asking, because the most dangerous wrong answer is
not a made-up number. It is a **real** number about something slightly different:
the whole instance's totals presented under one workflow's name, or last week's
figure when you asked about yesterday. Both read perfectly.

A step in red is one that failed. The assistant usually recovers on the next
step; the line stays visible so you can see it happened.

---

## Freshness, and why the sidebar says so

Every page's sidebar carries two indicators, and they answer different
questions:

- **Sync status** — when the copying process last finished a pass. If this is
  stale, everything on screen may be out of date.
- **n8n online** — whether your n8n itself is reachable.

A healthy pipeline over a quiet n8n looks identical, from the outside, to a
broken pipeline. That is why there are two.

The assistant knows both, and will tell you when an answer is based on data
older than you probably expect.

---

## Known limits

**It can pick the wrong analysis.** Especially on a vaguely worded question. If
an answer looks like it is about the wrong thing, it usually is — open the steps
and see. Re-asking more specifically works.

### ROI is only as good as what you configured

The time-and-money-saved figures come from per-workflow numbers **someone typed
in** (ROI → Configure). On an instance where most workflows are
unconfigured, the total is not a measurement, and the assistant should say so.
If it quotes you a confident figure without that caveat, distrust the figure,
not the caveat.

**It is not a monitor.** It answers when asked. For "tell me when X happens",
use Alerts.

**One question at a time works better than five.** A question with five parts
tends to get four answered well and one quietly dropped.
