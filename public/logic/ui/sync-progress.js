/**
 * "This is filling up — wait, don't press anything."
 *
 * ── The experience this exists to remove ─────────────────────────────────
 *
 * A new instance creates its replica and starts syncing. Five stages of a pass
 * are deliberately bounded — a row limit on executions, a chunk size on the
 * error queue, a time budget on each of three backfills — so no single cycle
 * holds the write gate for minutes. Correct, and it means the first pass does
 * not finish the job.
 *
 * Nothing said so. The dashboard rendered pages of plausible, quietly
 * incomplete numbers, and the only signal available was noticing that the
 * alerting was reasoning about data hours older than it should have been. The
 * remedy a person arrives at unaided is pressing "Sync now" over and over.
 *
 * The scheduler now continues on its own (see `runSyncPass` in server.js). This
 * is the other half: saying that it is happening, and roughly how far along.
 *
 * ── Why a sheet and not a toast ──────────────────────────────────────────
 *
 * Only on the FIRST run, when the pages are empty or nearly so. A person
 * looking at an empty dashboard with no explanation concludes the product does
 * not work; that is worth interrupting for, and there is nothing behind it to
 * interrupt. Once there is data on the pages the interruption stops being
 * justified — the pages are usable, they are merely incomplete — so it steps
 * down to the status line in the sidebar, which says "Catching up · 43%".
 *
 * It is dismissible either way. A person who wants to look around while it
 * fills is not wrong, and a modal that will not let them is a modal they resent
 * rather than read.
 */

(function () {
    'use strict';

    const STAGES = {
        executions: 'Reading executions',
        details: 'Filling in execution details',
        errors: 'Extracting error detail',
        grouping: 'Grouping errors'
    };

    /** Dismissed for this tab only — a reload is a fair way to ask again. */
    let dismissed = false;
    let host = null;

    function build() {
        const el = document.createElement('div');
        el.className = 'sync-sheet';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.innerHTML = `
            <div class="sync-sheet-card">
                <div class="sync-sheet-head">
                    <i class="fa-solid fa-arrows-rotate fa-spin"></i>
                    <div>
                        <h2>Setting up your dashboard</h2>
                        <p id="syncSheetStage">Reading your n8n history…</p>
                    </div>
                </div>

                <div class="sync-bar"><div class="sync-bar-fill" id="syncSheetFill"></div></div>
                <div class="sync-sheet-meta">
                    <span id="syncSheetPct">0%</span>
                    <span id="syncSheetLeft"></span>
                </div>

                <p class="sync-sheet-note">
                    This runs by itself and usually takes a couple of minutes. There is nothing
                    to press &mdash; it continues in the background even if you close this.
                </p>

                <button type="button" class="btn btn-sm" id="syncSheetDismiss">
                    Look around anyway
                </button>
            </div>`;
        el.querySelector('#syncSheetDismiss').addEventListener('click', () => {
            dismissed = true;
            el.remove();
            host = null;
        });
        document.body.appendChild(el);
        return el;
    }

    /**
     * @param {object} state  the `catching_up` block from /api/analytics/system?brief=1
     */
    function show(state) {
        document.dispatchEvent(new CustomEvent('sync:progress', { detail: state }));

        // The sheet is for the first run only. A catch-up on a replica that
        // already has data belongs in the status line, not across the page.
        if (dismissed || state.phase !== 'first_run') return;

        if (!host) host = build();

        const pct = Math.max(0, Math.min(100, Number(state.pct) || 0));
        host.querySelector('#syncSheetFill').style.width = `${pct}%`;
        host.querySelector('#syncSheetPct').textContent = `${pct}%`;
        host.querySelector('#syncSheetStage').textContent =
            `${STAGES[state.stage] || 'Working'}…`;

        const left = Number(state.remaining) || 0;
        host.querySelector('#syncSheetLeft').textContent =
            left > 0 ? `${left.toLocaleString()} rows to go` : '';
    }

    /**
     * Nothing outstanding.
     *
     * The reload is the part that matters and it only happens if the sheet was
     * actually on screen. Somebody who watched it fill is looking at a page
     * rendered from an empty replica; leaving them on it means the first thing
     * they see after "done" is still zeroes, which undoes the whole point.
     */
    function hide(state) {
        document.dispatchEvent(new CustomEvent('sync:progress', {
            detail: state || { active: false }
        }));
        if (!host) return;

        host.querySelector('#syncSheetFill').style.width = '100%';
        host.querySelector('#syncSheetPct').textContent = '100%';
        host.querySelector('#syncSheetStage').textContent = 'Done — loading your data…';
        host.querySelector('#syncSheetLeft').textContent = '';
        setTimeout(() => window.location.reload(), 900);
    }

    window.SyncProgress = { show, hide };
})();
