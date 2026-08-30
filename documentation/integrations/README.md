# Integrations

*Everything this dashboard connects to beyond n8n's own database, and the
exact clicks to set each one up. Three things live here: the AI provider,
the n8n documentation lookup, and alert delivery channels.*

All three are configured from the running app — Settings or the Alerts page
— not from environment variables and a restart. That's a deliberate choice:
this dashboard is usually installed next to an n8n instance by the person who
runs it, and asking them to edit a file on the host and restart a process to
try a different model is exactly the kind of barrier this project keeps
removing.

---

## The AI assistant's model and API key

**Settings → Assistant → "Model & API key"**, not "Integrations" — the tab
was renamed on purpose: *"a reader looking for 'why can't the assistant
answer' was not looking for a plug icon."*

### "I want to turn the assistant on"

1. Settings → Assistant.
2. Paste your OpenAI key into **OpenAI API key**.
3. Leave **Model** blank (recommended) or type a specific model id — the
   field is free text, not a dropdown, so a model released after this page
   shipped is usable the day it's released. A substitute must accept
   `temperature` **and** support function tools on `/v1/chat/completions`;
   several recent models fail one or the other, and it will tell you on your
   first question rather than at save time.
4. Click **Save**.
5. The badge above the fields turns green — *"Key configured"* — showing the
   last four characters and where the key is coming from.

That's it. No restart. The rest of the dashboard works identically without
this step; only the chat panel needs it.

### "I want to know whether I'm paying for the key in `.env` or the one I just saved"

The status line under the badge says so explicitly: `…ab12 · from the server
environment` or `…ab12 · set here`. **Settings always wins over `.env`**, and
clearing the Settings key doesn't disable the assistant if
`OPENAI_API_KEY` is still set in the environment — the status line reflects
whichever one is actually in force, so you're never guessing which account
is being billed.

### "I want to remove the key I saved here"

A red **Remove key** button appears only when the key in force came from
Settings — there's nothing to show it when the environment variable is doing
the work instead. Clicking it falls back to `.env` if one exists, or turns
the assistant off if not.

> [!NOTE]
> Saving or clearing the key requires an n8n `owner` or `admin` role — it
> spends someone's billing account. Reading whether it's configured is open
> to every user, so a teammate can tell at a glance whether to ask an admin
> rather than filing a confusing bug report.

---

## The n8n documentation lookup

Optional, and separate from the assistant working at all — without it, the
assistant answers from your instance's own data only. With it connected, it
can also answer *"what does the documentation say about configuring retries
on an HTTP Request node?"* from n8n's official docs.

**It is connected per person, not per deployment, and deliberately has no
shared fallback.** The credential is issued against the approving person's
own account at the documentation service; one shared connection would
attribute every question to whoever approved it. Each teammate who wants
this connects their own.

### "I want to connect it, and I have a browser"

1. Settings → Assistant → **"n8n documentation"** card → **Connect**.
2. A popup opens the documentation service's own consent screen. Approve
   access there.
3. The popup shows *"Connected — the assistant can now answer from the n8n
   documentation. You can close this tab,"* and closes itself after a moment.
4. Back on the Settings page, the badge flips to green — **Connected**.

If your browser blocks the popup, the page tells you to allow popups for the
site and try again — it also re-checks your connection status when the
Settings tab regains focus, in case the popup became a full tab instead and
you closed it manually.

### "I want to connect it on a headless box with no browser"

```bash
node src/scripts/connectDocsMcp.js <your-email-or-user-id>
```

The target user has to have logged into the dashboard at least once already
— the script attaches the connection to an existing local user record. It
runs the identical OAuth flow the UI does, tries to open a browser on its own
(and prints the URL to copy by hand if it can't), and waits up to five
minutes for you to approve access.

> [!IMPORTANT]
> The script listens for the OAuth callback on `127.0.0.1:8765` on the
> machine it's running on. If your dashboard runs on a remote server you
> reach over SSH, the browser that approves the connection has to be able to
> reach that same `127.0.0.1:8765` — which usually means running the script
> on your own machine against a tunnel, or forwarding the port
> (`ssh -L 8765:localhost:8765 ...`) while it runs on the server. Running the
> script on the server and clicking the link from your laptop's browser will
> not complete the callback.

### "I want to disconnect it"

Settings → Assistant → **Disconnect**. Immediate — the docs tool disappears
from your next chat message without a restart.

---

## Alert channels

Alerts are configured entirely on the **Alerts** page: rules describe *when*
to fire (see [../operations](../operations#alerting) for the full seven rule
types), channels describe *where* the alert goes. This section is about the
channels.

Three channel types exist: **Webhook**, **Trigger an n8n workflow**, and
**Telegram**. The first two share a wire format — the second is just a
webhook aimed at your own n8n instance's Webhook trigger node, which is
usually the right answer: the dashboard tells n8n, and n8n decides what to do
with its own credentials, which is how this project gets email/Slack/ticket
alerts without ever learning your SMTP password.

### "I want a Telegram message when a workflow starts failing a lot"

1. **Alerts → Channels → New channel.**
2. Name it (e.g. *"Ops Telegram"*), Type = **Telegram**.
3. Fill in **Bot token** (from [@BotFather](https://t.me/BotFather)) and
   **Chat ID** (the chat or group the bot should post into). Save.
4. Click the **Test** (flask icon) on that row and confirm the message
   actually arrives — do this before relying on the channel, not after.
5. **Alerts → Rules → New rule.**
6. Name it, **Fire when** → *"Error rate above a percentage."*
7. **Threshold**: e.g. `20` (percent). **Measured over**: e.g. `60` minutes.
   **At most one alert per**: e.g. `120` minutes, so a workflow stuck failing
   doesn't page you every minute. **Ignore below this many executions**: e.g.
   `20`, so one failure out of two doesn't read as a 50% outage.
8. **Watching** → the specific workflow, or *"Every workflow."*
9. **Send it to** → *"Ops Telegram."* Save.

Optionally hit **Evaluate now** at the top of the Rules card to run the pass
immediately rather than waiting for the next scheduled cycle — this
deliberately bypasses the staleness guard, since a human clicking it already
knows the risk.

### "I want to point an alert at my own n8n instance, which is on the same server"

Loopback and private-network addresses (`127.0.0.1`, `10.*`, `192.168.*`,
`172.16–31.*`, `localhost`) are refused **by default**, because a blind
webhook aimed at an internal address is exactly the kind of mistake worth
guarding against. Since n8n very often runs on the same host or network as
this dashboard, that guard would otherwise block the single most useful
channel there is.

Set, in the dashboard's own `.env`:

```env
ALERT_ALLOW_PRIVATE_TARGETS=true
```

Link-local addresses (`169.254.*` — the cloud metadata endpoint on every
major provider) are refused unconditionally, with no override, because
there is no deployment where an alert legitimately targets one.

### "I want to paste a `curl` command a service's docs gave me, instead of filling in fields by hand"

On a **Webhook** or **Trigger an n8n workflow** channel, expand **"Start from
a cURL command,"** paste the command (as copied straight from that service's
setup page), and click **Fill the form from this**. It's parsed on the
server — never executed — and pre-fills the URL and headers, telling you
about anything it had to drop (a `GET` method becomes a note that alerts are
always delivered as `POST`; a `Content-Type` header is dropped since the
dashboard always sets its own).

The reverse also exists: **Export this channel** on an existing channel
returns the equivalent `curl` command, with any secret value shown masked —
the API never returns a stored secret to the browser, in an export or
anywhere else.

### "I want to add a custom header, like a signing secret my endpoint expects"

Add rows under **Custom headers** on a Webhook or n8n-workflow channel — up
to 10, and a handful of headers the dashboard sets itself
(`Content-Type`, `Host`, `Content-Length`, …) can't be overridden. Leaving a
previously-saved header's value blank when editing the channel means *keep
what's stored*, resolved per row by header name — so renaming one header can
never accidentally wipe another's secret.

---

## One setting that's `.env`-only, deliberately

**`N8N_EDITOR_BASE_URL`** — your n8n instance's own URL — has no UI. It's
read directly wherever this dashboard builds a deep link back into the n8n
editor (an alert's *"open in n8n"* link, a failing execution's row, the error
modal). Set it once in `.env`:

```env
N8N_EDITOR_BASE_URL=https://your-n8n-instance.com
```

If it's unset, those links are simply omitted rather than shown broken.
