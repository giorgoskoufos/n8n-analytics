/**
 * The tool surface the assistant sees.
 *
 * Six tools, not twenty-plus. The reasoning is in analytics.js: the DAO layer
 * gave every analysis the same parameter envelope, so they collapse into one
 * dispatching tool whose `metric` enum carries the choice. What is left here is
 * the small set of genuinely different shapes.
 *
 *   search_catalog     resolve a name to an id — always before anything else
 *   describe_instance  what this replica covers, how fresh, what it cannot see
 *   get_analytics      the twenty analyses, one envelope
 *   drill_down         one execution, one fingerprint, one workflow
 *   run_sql            the narrow escape hatch, guarded three ways
 *   ask_n8n_docs       how n8n is meant to work — registered only if configured
 *
 * Registration is conditional on purpose. A tool the model can see but cannot
 * use is worse than an absent one: it will be chosen, fail, and the failure will
 * read to the user as the assistant being broken.
 */

const { METRICS } = require('./analytics');
const { DRILLDOWNS } = require('./drilldown');
const { MAX_ROWS } = require('../../utils/sqlGuard');
const { ALLOWED_VIEWS } = require('../../config/aiViews');

/** The shared analytics envelope, declared once. */
const ENVELOPE = {
    startDate: {
        type: 'string',
        description: 'ISO 8601 start of the window. Omit for the metric\'s own default.'
    },
    endDate: {
        type: 'string',
        description: 'ISO 8601 end of the window. Omit for now.'
    },
    mode: {
        type: 'string',
        enum: ['webhook', 'trigger', 'manual', 'integrated', 'retry', 'error', 'cli', 'internal'],
        // The `error` value is a trap and has to be defused here rather than
        // explained afterwards. Asked "which workflows fail most and with what
        // errors", a model passed mode:"error" to error_intelligence, read it as
        // "restrict to failures", got the near-empty set of error-handler runs,
        // and reported that no error details were available. The metric was
        // right, the filter was right, and the answer was wrong.
        description: 'How the execution was STARTED — not whether it succeeded. ' +
            '"webhook" is an incoming HTTP call, "trigger" a schedule or poller, ' +
            '"manual" a person pressing Execute, "retry" a re-run of a failed execution, ' +
            'and "error" means the run was itself an error-handling workflow, which is rare. ' +
            'To ask about failures, do NOT set this — every metric already reports failures ' +
            'within whatever set you select. Honoured by kpis, execution_volume and ' +
            'error_intelligence; ignored by metrics that do not split on it.'
    },
    // The filter whose absence was a wrong-answer generator. Without it the
    // model had folder, tag and project and no way to say "this one workflow" —
    // so asked about one, it either dropped the filter and reported the whole
    // instance under that workflow's name, or put the workflow id into `folder`,
    // which is id-shaped, passes validation, matches no folder, and returns
    // zero. Both were observed on real data in the same conversation.
    workflow: {
        type: 'string',
        description: 'Workflow id — from search_catalog, or given to you in a tag. ' +
            'Narrows the analysis to that one workflow. Use it whenever the question ' +
            'names a workflow: without it the answer describes the whole instance.'
    },
    folder: { type: 'string', description: 'Folder id from search_catalog. Includes sub-folders.' },
    tag: { type: 'string', description: 'Tag id from search_catalog.' },
    project: { type: 'string', description: 'Project id from search_catalog.' }
};

function metricEnumDescription() {
    return Object.entries(METRICS)
        .map(([name, m]) => `- ${name}: ${m.describe}`)
        .join('\n');
}

// `docsEnabled` is passed rather than asked for here, because whether the docs
// tool exists depends on whether THIS user has connected it — and a registry
// does not know who is asking. See dao/integrationsDao for why the credential is
// per person.
function build({ sqlEnabled = true, docsEnabled = false } = {}) {
    const tools = [
        {
            type: 'function',
            function: {
                name: 'search_catalog',
                description:
                    'Find what exists on this instance by name: workflows, folders, tags, ' +
                    'projects, node types, and error groups. Use this FIRST whenever the question ' +
                    'names something, because ids are what every other tool takes and a guessed ' +
                    'id silently returns nothing rather than failing.',
                parameters: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Words to look for. Partial names work.' },
                        kind: {
                            type: 'string',
                            enum: ['workflow', 'folder', 'tag', 'project', 'node_type', 'error_group'],
                            description: 'Restrict to one kind. Omit to search everything.'
                        },
                        limit: { type: 'integer', description: 'Default 10, maximum 50.' }
                    },
                    required: ['query']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'describe_instance',
                description:
                    'What this dashboard can and cannot answer right now: the date range the ' +
                    'replica covers, how far behind the live instance it is, how many workflows ' +
                    'and executions it holds, and which kinds of data are deliberately not ' +
                    'available. Call this when a question depends on freshness, when a result ' +
                    'looks empty, or before saying that something did not happen.',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'get_analytics',
                description:
                    'Run one of the dashboard\'s own analyses. These are the same computations the ' +
                    'pages show, so their numbers agree with what the user sees.\n\n' +
                    'Available metrics:\n' + metricEnumDescription(),
                parameters: {
                    type: 'object',
                    properties: {
                        metric: {
                            type: 'string',
                            enum: Object.keys(METRICS),
                            description: 'Which analysis to run. See the list in the description.'
                        },
                        ...ENVELOPE
                    },
                    required: ['metric']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'drill_down',
                description:
                    'Look at one specific thing rather than an aggregate.\n' +
                    Object.entries(DRILLDOWNS)
                        .map(([k, d]) => `- ${k}: ${d.describe}`).join('\n'),
                parameters: {
                    type: 'object',
                    properties: {
                        kind: { type: 'string', enum: Object.keys(DRILLDOWNS) },
                        id: {
                            type: 'string',
                            description: 'The execution id, workflow id or fingerprint, ' +
                                'depending on kind.'
                        }
                    },
                    required: ['kind', 'id']
                }
            }
        }
    ];

    if (sqlEnabled) {
        tools.push({
            type: 'function',
            function: {
                name: 'run_sql',
                description:
                    'Last resort, for a question none of the metrics above answers — an unusual ' +
                    'grouping, a specific hour of the week, a correlation nobody built a panel ' +
                    'for. Prefer get_analytics: it is tested, and it agrees with the pages.\n\n' +
                    `Read-only SQLite. Only these views exist: ${[...ALLOWED_VIEWS].join(', ')}. ` +
                    'They already carry the caller\'s permissions, so do not add any filter for ' +
                    `that. Results are capped at ${MAX_ROWS} rows. Call describe_views first if ` +
                    'you need the columns.',
                parameters: {
                    type: 'object',
                    properties: {
                        sql: { type: 'string', description: 'One SELECT statement.' },
                        purpose: {
                            type: 'string',
                            description: 'One line on what this is meant to answer. Shown to the ' +
                                'user in place of the query itself.'
                        }
                    },
                    required: ['sql', 'purpose']
                }
            }
        });
    }

    if (sqlEnabled) {
        // Declared next to run_sql because it exists only to serve it. An
        // earlier version of the run_sql description told the model to "call
        // describe_views first" and no such tool existed — a promise the
        // assistant would have discovered mid-answer, as an unknown-tool error
        // in front of the user.
        tools.push({
            type: 'function',
            function: {
                name: 'describe_views',
                description:
                    'The columns available to run_sql, and what each view holds. Call this ' +
                    'before writing a query rather than guessing a column name: a wrong one is ' +
                    'an error, and a plausible-but-absent one is usually a column that was left ' +
                    'out deliberately.',
                parameters: {
                    type: 'object',
                    properties: {
                        view: {
                            type: 'string',
                            description: 'One view. Omit for all of them.'
                        }
                    }
                }
            }
        });
    }

    // Registered unconditionally, because a conversation always has a user and
    // a user can always have a preference. It is the only tool here that WRITES
    // anything, which is why its description is mostly a list of what not to
    // put in it: a memory is repeated into every future prompt, so a wrong one
    // is not a wrong answer once, it is a wrong premise forever.
    tools.push({
        type: 'function',
        function: {
            name: 'remember',
            description:
                'Keep one short fact about THIS PERSON so future conversations start knowing it. ' +
                'Use it when they tell you how they want to work — which part of the instance ' +
                'they are responsible for, how they want numbers presented, what they have ' +
                'already decided not to care about.\n\n' +
                'Only ever what they have actually said about themselves. Never a measurement ' +
                '(those change, and you can look them up), never something you inferred from ' +
                'their questions, and never anything about another person. If you are about to ' +
                'save something they did not say, do not.',
            parameters: {
                type: 'object',
                properties: {
                    fact: {
                        type: 'string',
                        description: 'One sentence, in the third person, that will still be ' +
                            'true next month. "Reports on the Call Center folder." ' +
                            '"Wants absolute counts alongside every rate."'
                    }
                },
                required: ['fact']
            }
        }
    });

    if (docsEnabled) {
        tools.push({
            type: 'function',
            function: {
                name: 'ask_n8n_docs',
                description:
                    'Ask the official n8n documentation how something is meant to work — node ' +
                    'configuration, expression syntax, what an error message means, how a feature ' +
                    'behaves. This knows nothing about THIS instance; pair it with get_analytics ' +
                    'when the user asks not just what broke but why, or what to do about it.',
                parameters: {
                    type: 'object',
                    properties: {
                        question: {
                            type: 'string',
                            description: 'A full question, not keywords. Include the node type or ' +
                                'error text when there is one.'
                        }
                    },
                    required: ['question']
                }
            }
        });
    }

    return tools;
}

module.exports = { build, ENVELOPE, metricEnumDescription };
