/**
 * The dataset: twenty conversations, and what each turn has to get right.
 *
 * Two rules govern what is in here.
 *
 * ONE — every scenario is a question somebody would actually ask, phrased the
 * way they would actually phrase it. Half of them are in Greek because that is
 * the language this instance is operated in, and a model that routes tools
 * correctly in English and not in Greek is broken for its users.
 *
 * TWO — every expectation is checkable without an opinion. The tool calls are
 * recorded with their arguments; the figures are compared against the DAOs; the
 * subject of a thread is a name that is either in the answer or is not. What is
 * deliberately NOT here is a judge scoring prose, because a number that cannot
 * be disputed is worth more than a score that can.
 *
 * `build(truth)` receives the numbers and ids read from the replica moments
 * earlier, so a scenario names today's figures without anyone maintaining a
 * fixture.
 *
 * ── The negative cases are the point ─────────────────────────────────────
 *
 * Several scenarios exist only to catch the fix for an earlier one going too
 * far. S06 asks an instance-wide question and fails if the answer is scoped to
 * a workflow; S08 changes subject mid-thread and fails if the assistant sticks
 * to the old one. Without those, "always scope to the last workflow mentioned"
 * would score perfectly and be useless.
 */

function build(truth) {
    const proc = truth.workflows.processor;
    const call = truth.workflows.callCenter;
    const worst = truth.workflows.worst;
    const folder = truth.folders[0];
    const tag = truth.tags[0];
    const failed = truth.executions.failed;
    const ok = truth.executions.ok;

    // "It scoped this to that workflow" — by id, however it came by the id.
    const scopedTo = (id) => ({ workflow: (v) => v === id });
    // "It did not scope this to anything" — the instance-wide questions.
    const unscoped = { workflow: (v) => !v, folder: (v) => !v, tag: (v) => !v };

    const S = [];
    const add = (id, why, turns, extra = {}) => S.push({ id, why, turns, ...extra });

    // ── The failures that started this ───────────────────────────────────

    add('S01 · one workflow, named by tag',
        'The tagged id used to land in `folder`, which is id-shaped, matches no folder, ' +
        'and returns zero. The answer opened with "0 executions" and closed with 10,070.',
        [{
            message: `πώς πάει το @workflow:${proc.id} ;`,
            tools: { expect: [{ tool: 'get_analytics', args: scopedTo(proc.id) }] },
            stats: {
                must: [{ label: `${proc.name} executions`, value: proc.total }],
                traps: [{ label: 'the whole instance', value: truth.instance.total }]
            },
            context: { subject: proc.name },
            contradiction: true
        }]);

    add('S02 · one workflow, named in prose',
        'With no `workflow` filter to reach for, the model dropped the filter and reported ' +
        "the instance's totals under this workflow's name — a factor of three out.",
        [{
            message: `πώς πάει το ${proc.name};`,
            tools: {
                expect: [{ tool: 'search_catalog' }, { tool: 'get_analytics', args: scopedTo(proc.id) }]
            },
            stats: {
                must: [{ label: `${proc.name} executions`, value: proc.total }],
                traps: [
                    { label: 'the whole instance', value: truth.instance.total },
                    { label: "the instance's error count", value: truth.instance.errors }
                ]
            },
            context: { subject: proc.name }
        }]);

    add('S03 · the subject survives a pronoun',
        'Asked for "three examples of errors" after a turn about one workflow, it returned ' +
        "three OTHER workflows' error groups under this one's name.",
        [
            {
                message: `πώς πάει το ${proc.name};`,
                tools: { expect: [{ tool: 'get_analytics', args: scopedTo(proc.id) }] },
                context: { subject: proc.name }
            },
            {
                message: 'και τα σφάλματά του;',
                tools: { expect: [{ tool: 'get_analytics', args: scopedTo(proc.id) }] },
                context: { subject: proc.name, strangers: truth.othersThan(proc.name) }
            },
            {
                message: 'δώσε μου τρία παραδείγματα',
                context: { strangers: truth.othersThan(proc.name) }
            }
        ]);

    // ── Windows, and the difference between two of them ──────────────────

    add('S04 · a named window is honoured',
        'A question that names its own window must not be answered with the metric default. ' +
        'The 24h and 7d numbers differ by roughly seven times here.',
        [{
            message: `πόσες εκτελέσεις είχε το ${call.name} τις τελευταίες 24 ώρες;`,
            tools: {
                expect: [{
                    tool: 'get_analytics',
                    args: { workflow: (v) => v === call.id, startDate: (v) => Boolean(v) }
                }]
            },
            stats: { traps: [{ label: 'the 7-day figure', value: call.total }] },
            context: { subject: call.name }
        }]);

    add('S05 · comparing two windows in one turn',
        'Two measurements of the same thing, which is where a model most easily reports one ' +
        'number twice.',
        [{
            message: `σύγκρινε τις εκτελέσεις του ${call.name} αυτή την εβδομάδα με την προηγούμενη`,
            tools: { expect: [{ tool: 'get_analytics', args: scopedTo(call.id) }] },
            context: { subject: call.name }
        }]);

    // ── The negative cases ───────────────────────────────────────────────

    add('S06 · an instance-wide question stays instance-wide',
        'The counterweight to S01–S03. A fix that makes the assistant scope to a workflow ' +
        'whenever it can would score perfectly on those and be wrong here.',
        [{
            message: 'πώς πάει το instance συνολικά αυτή την εβδομάδα;',
            tools: { expect: [{ tool: 'get_analytics', args: unscoped }] },
            stats: { must: [{ label: 'instance executions', value: truth.instance.total }] }
        }]);

    add('S07 · how many workflows are there',
        'An inventory question. It has one right answer and no window, and it is the cheapest ' +
        'possible check that counts are not being invented.',
        [{
            message: 'πόσα workflows υπάρχουν συνολικά στο instance;',
            stats: { must: [{ label: 'workflow count', value: truth.instance.workflowCount }] }
        }]);

    add('S08 · the thread is allowed to change subject',
        'The other half of context. Carrying the previous subject forward is right for a ' +
        'pronoun and wrong the moment the question names something else.',
        [
            {
                message: `πώς πάει το ${proc.name};`,
                tools: { expect: [{ tool: 'get_analytics', args: scopedTo(proc.id) }] },
                context: { subject: proc.name }
            },
            {
                message: `τώρα δείξε μου το ${call.name}`,
                tools: { expect: [{ tool: 'get_analytics', args: scopedTo(call.id) }] },
                stats: {
                    must: [{ label: `${call.name} executions`, value: call.total }],
                    traps: [{ label: `${proc.name}'s figure`, value: proc.total }]
                },
                context: { subject: call.name }
            }
        ]);

    // ── Grouping that is not a workflow ──────────────────────────────────

    if (folder) {
        add('S09 · a folder is a folder, not a workflow',
            'The filter the workflow id was being smuggled into. It has to still work as itself.',
            [{
                message: `πώς πάει ο φάκελος "${folder.name}";`,
                tools: { expect: [{ tool: 'get_analytics', args: { folder: (v) => v === folder.id } }] }
            }]);
    }

    if (tag) {
        add('S10 · grouping by tag',
            'Same shape, different axis. Also checks the catalogue resolves a tag by name.',
            [{
                message: `δείξε μου τα workflows με tag "${tag.name}" και πώς πάνε`,
                tools: {
                    expect: [
                        { tool: 'search_catalog' },
                        { tool: 'get_analytics', args: { tag: (v) => v === tag.id } }
                    ]
                }
            }]);
    }

    // ── The analyses that are not a single SELECT ────────────────────────

    add('S11 · queue lag is not the error rate',
        '"Is the queue keeping up" and "is anything failing" are different questions with ' +
        'different metrics, and the second is the easy one to answer by mistake.',
        [{
            message: 'προλαβαίνει η ουρά; υπάρχει backpressure;',
            tools: { expect: [{ tool: 'get_analytics', args: { metric: 'queue_lag' } }] }
        }]);

    add('S12 · concurrency is not volume',
        'How many ran at the same instant, against how many started — a much larger number, ' +
        'and the one a model reaches for when the metric is not obvious.',
        [{
            message: 'πόσα executions έτρεχαν ταυτόχρονα στην αιχμή;',
            tools: { expect: [{ tool: 'get_analytics', args: { metric: 'concurrency' } }] }
        }]);

    add('S13 · slow is not broken',
        'Duration, not failures. The follow-up then has to go a level deeper rather than ' +
        'repeating the same table.',
        [
            {
                message: 'ποια workflows είναι τα πιο αργά;',
                tools: { expect: [{ tool: 'get_analytics', args: { metric: 'slowest' } }] }
            },
            {
                message: 'γιατί είναι αργό το πρώτο; πού πάει ο χρόνος;',
                tools: { expect: [{ tool: 'get_analytics', args: { metric: 'node_profile' } }] }
            }
        ]);

    add('S14 · silence is not an error',
        'Workflows that stopped running without failing. Nothing in the error metrics can ' +
        'answer this, so reaching for them is the failure.',
        [{
            message: 'υπάρχει workflow που σταμάτησε να τρέχει χωρίς να βγάλει σφάλμα;',
            tools: { expect: [{ tool: 'get_analytics', args: { metric: 'silent_workflows' } }] }
        }]);

    add('S15 · what breaks if a credential expires',
        'Blast radius. A question about dependencies that looks like a question about errors.',
        [{
            message: truth.credential
                ? `τι θα σπάσει αν λήξει το credential "${truth.credential.name}";`
                : 'τι θα σπάσει αν λήξει ένα credential;',
            tools: { expect: [{ tool: 'get_analytics', args: { metric: 'blast_radius' } }] }
        }]);

    add('S16 · did something change just before this started',
        'Deploys, correlated against the error rate either side. The temptation is to answer ' +
        'from the error metrics alone and assert a cause.',
        [{
            message: 'άλλαξε κάτι σε κάποιο workflow πριν αρχίσουν τα σφάλματα;',
            tools: { expect: [{ tool: 'get_analytics', args: { metric: 'deploys' } }] }
        }]);

    // ── Drill-downs, which take an id rather than a window ───────────────

    if (ok) {
        add('S17 · one execution, by id',
            'A trace takes an execution id, not a workflow id. Passing the wrong one is the ' +
            'mistake, and it is silent.',
            [{
                message: `τι έγινε στο @execution:${ok.id} ;`,
                tools: {
                    expect: [{ tool: 'drill_down', args: { id: (v) => String(v) === String(ok.id) } }]
                }
            }]);
    }

    if (failed) {
        add('S18 · a failure, and then its group',
            'The two-step a person actually does: look at the one that broke, then ask whether ' +
            'it is a pattern.',
            [
                {
                    message: `γιατί απέτυχε το @execution:${failed.id} ;`,
                    tools: {
                        expect: [{ tool: 'drill_down', args: { id: (v) => String(v) === String(failed.id) } }]
                    }
                },
                {
                    // Two defensible answers: count the failures across
                    // workflows, or read this one workflow's failure history.
                    // The scenario originally demanded the first, which is what
                    // the model did before the drill-down was renamed — so the
                    // rename "broke" a turn by making it pick the better tool.
                    //
                    // `workflow_failure_history` is a get_analytics METRIC now,
                    // not a drill_down kind. This turn was red on purpose while
                    // it sat in the wrong registry: the model kept reaching for
                    // get_analytics, which was the correct instinct about a tool
                    // whose input is a workflow id, and spent a recovered step
                    // being told otherwise. The expectation follows the tool.
                    message: 'είναι μεμονωμένο ή συμβαίνει συχνά;',
                    tools: {
                        oneOf: [
                            { tool: 'get_analytics', args: { metric: 'errors_by_workflow' } },
                            { tool: 'get_analytics', args: { metric: 'workflow_failure_history' } },
                            { tool: 'get_analytics', args: { metric: 'error_intelligence' } }
                        ]
                    }
                }
            ]);
    }

    if (worst) {
        add('S19 · the thing that is actually broken',
            'Open-ended. Whatever it answers has to name the workflow that genuinely has the ' +
            'most failures this week, which is decided by the replica and not by the scenario.',
            [{
                message: 'τι είναι το πιο σοβαρό πρόβλημα αυτή τη στιγμή;',
                // Unscoped, and this is not pedantry: with one memory present
                // this exact question was answered about a single folder, and
                // passed, because the only thing asserted was a name that
                // appeared in both answers.
                tools: { expect: [{ tool: 'get_analytics', args: unscoped }] },
                context: { subject: worst.name }
            }]);
    }

    // ── Honesty, routing, memory ─────────────────────────────────────────

    add('S20 · what it must refuse to know',
        'The `ai_*` views do not carry execution payload — the column is absent, so SQLite ' +
        'refuses it. The right answer says so; the wrong one invents a plausible record.',
        [{
            message: 'δείξε μου τα δεδομένα πελάτη που πέρασαν από την τελευταία εκτέλεση',
            // No tool expectation: refusing without calling anything is a fine answer,
            // and so is trying once and reporting that it cannot. What is not fine is
            // a confident answer, which the contradiction and stranger checks catch.
            context: { strangers: [] }
        }]);

    add('S21 · know-how goes to the docs',
        'Verified in both directions in the handoff, then observed failing in Greek: asked ' +
        'what the docs say, the model paraphrased the error text instead of calling the tool.',
        [
            {
                message: 'τι λένε τα n8n docs για το πώς ρυθμίζω retry σε ένα HTTP Request node;',
                tools: { expect: [{ tool: 'ask_n8n_docs' }], forbid: ['get_analytics'] }
            },
            {
                message: `και πόσες εκτελέσεις είχε το ${call.name} αυτή την εβδομάδα;`,
                tools: {
                    expect: [{ tool: 'get_analytics', args: scopedTo(call.id) }],
                    forbid: ['ask_n8n_docs']
                },
                stats: { must: [{ label: `${call.name} executions`, value: call.total }] }
            }
        ],
        { requires: 'docs' });

    add('S22 · a preference is remembered',
        'Memory is what makes a second conversation cheaper than the first. If `remember` is ' +
        'never called there is nothing to carry.',
        [{
            message: 'Να θυμάσαι ότι είμαι υπεύθυνος για το folder Call Center και θέλω πάντα ' +
                'απόλυτους αριθμούς δίπλα στα ποσοστά.',
            tools: { expect: [{ tool: 'remember' }] }
        }],
        {
            // A memory outlives the conversation it was written in — that is the
            // point of it — so this is the one scenario that is not repeatable by
            // construction. Run twice, the second run correctly answers "already
            // noted" and calls nothing, and the check reads a right answer as a
            // failure. It also leaves a fixture in a real person's memory list.
            marker: 'απόλυτους αριθμούς',
            cleanMemories: true
        });

    add('S23 · a question with no answer in the data',
        'The replica holds executions, not business outcomes. Saying so is the answer; ' +
        'producing a number is the failure.',
        [{
            message: 'πόσα χρήματα έβγαλε η εταιρεία από αυτά τα workflows τον προηγούμενο μήνα;',
            // "The company", not a folder of it. A turn with no expectations is
            // recorded and proves nothing, which is how this one passed while
            // answering about one folder.
            tools: { expect: [{ tool: 'get_analytics', args: unscoped }] }
        }]);

    add('S24 · ROI is only as good as its settings',
        'The metric exists and is mostly unconfigured on this instance, so the honest answer ' +
        'names that caveat rather than presenting the figure as measured.',
        [{
            message: 'πόσο χρόνο έχουμε γλιτώσει συνολικά;',
            tools: {
                expect: [{
                    tool: 'get_analytics',
                    args: { metric: (v) => /^roi/.test(v || ''), ...unscoped }
                }]
            }
        }]);

    add('S25 · storage, and where it is heading',
        'A cost question. Bounded to what n8n still holds rather than the replica\'s longer ' +
        'history, which is a caveat the metric carries and the answer should keep.',
        [{
            message: 'πόσο χώρο πιάνουν τα execution data και πού πάει;',
            tools: { expect: [{ tool: 'get_analytics', args: { metric: 'storage_forecast' } }] }
        }]);

    add('S26 · a memory is context, not a filter',
        'Found by this dataset and confirmed by deleting the memory and asking again. A note ' +
        'reading "is responsible for the Call Center folder" made the assistant answer "what is ' +
        'the most serious problem right now" about that folder — scoped, silently, with nothing ' +
        'in the question to suggest it. The memory is written through the tool rather than ' +
        'seeded, because that is the only way one is ever created.',
        [
            {
                message: 'Να θυμάσαι ότι είμαι υπεύθυνος για τον φάκελο ' +
                    `"${folder ? folder.name : 'Call Center'}".`,
                tools: { expect: [{ tool: 'remember' }] }
            },
            {
                message: 'τι είναι το πιο σοβαρό πρόβλημα σε ΟΛΟ το instance αυτή τη στιγμή;',
                tools: { expect: [{ tool: 'get_analytics', args: unscoped }] }
            }
        ],
        { marker: 'υπεύθυν', cleanMemories: true });

    return S;
}

module.exports = { build };
