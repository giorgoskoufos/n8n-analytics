/**
 * Lint configuration.
 *
 * Tuned to catch mistakes, not to enforce a house style. Prettier was considered
 * and deliberately left out: the formatting in this codebase carries meaning —
 * aligned SQL, aligned comment blocks, deliberate line breaks in long
 * explanations — and running a formatter over it would rewrite every file for no
 * defect found. A reviewer's diff full of whitespace is worse than one that is
 * only the change.
 *
 * The rules below are the ones that would have caught real bugs written during
 * this project: a variable used before its declaration (the logger require ended
 * up below its first use), an unused catch binding hiding a swallowed error, a
 * missing `await` on a promise that was assumed to be synchronous.
 */
const js = require('@eslint/js');

module.exports = [
    {
        ignores: [
            'node_modules/**',
            'public/vendor/**',      // third-party, not ours to lint
            'public/css/styles.css',
            'scratch/**',
            'tmp/**',
            'relevant/**'
        ]
    },

    // ---- Node: the server, config, controllers, scripts, tests ----
    {
        files: ['**/*.js'],
        ignores: ['public/**'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'commonjs',
            globals: {
                require: 'readonly', module: 'writable', exports: 'writable',
                process: 'readonly', console: 'readonly', Buffer: 'readonly',
                __dirname: 'readonly', __filename: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly',
                setInterval: 'readonly', clearInterval: 'readonly',
                setImmediate: 'readonly', fetch: 'readonly', URL: 'readonly',
                URLSearchParams: 'readonly',
                AbortController: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly'
            }
        },
        rules: {
            ...js.configs.recommended.rules,

            // Real-defect rules.
            'no-use-before-define': ['error', { functions: false, classes: false, variables: true }],
            'no-await-in-loop': 'off',        // deliberate throughout: the ETL paces itself
            // Off, after reviewing all five it reported. Each is a deliberate
            // single-writer assignment the rule cannot see the guard for:
            // `isSyncing = false` in a finally IS the mutex, `req.scope = await …`
            // writes to a per-request object nothing else touches, and the scope
            // availability cache resolves to the same value whichever racer wins.
            // Leaving it on would mean five permanent suppressions, which teaches
            // people to add a sixth without looking.
            'require-atomic-updates': 'off',
            'no-constant-binary-expression': 'error',
            'no-promise-executor-return': 'error',
            'no-unmodified-loop-condition': 'error',
            'no-unreachable-loop': 'error',
            'no-template-curly-in-string': 'warn',

            // An unused catch binding is usually a swallowed error. Allowed only
            // when named to say so — `catch (ignored)`.
            'no-unused-vars': ['error', {
                args: 'none',
                caughtErrorsIgnorePattern: '^(e|err|ignored)$',
                varsIgnorePattern: '^_'
            }],

            // Style rules that only fire on genuine ambiguity.
            eqeqeq: ['error', 'smart'],
            'no-var': 'error',
            'prefer-const': ['error', { destructuring: 'all' }]
        }
    },

    // ---- Browser: public/logic ----
    {
        files: ['public/logic/**/*.js'],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'script',
            globals: {
                window: 'readonly', document: 'readonly', console: 'readonly',
                localStorage: 'readonly', sessionStorage: 'readonly',
                fetch: 'readonly', location: 'readonly', navigator: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly',
                setInterval: 'readonly', clearInterval: 'readonly',
                alert: 'readonly', IntersectionObserver: 'readonly',
                URL: 'readonly', URLSearchParams: 'readonly', Event: 'readonly',
                CustomEvent: 'readonly',
                // Used by the F-24 UI layer: token reading (getComputedStyle),
                // the grouped-table collapse selector (CSS.escape) and the
                // inert parse of HTML error bodies (DOMParser).
                getComputedStyle: 'readonly', CSS: 'readonly', DOMParser: 'readonly',
                // Loaded from public/vendor before any of this runs.
                Chart: 'readonly', marked: 'readonly', DOMPurify: 'readonly',
                // Cross-file globals. This layer has no module system: files
                // communicate by assigning to window, so ESLint has no way to see
                // the contract without being told. Generated from the
                // `window.X =` assignments in public/logic — regenerate with:
                //   grep -rho '^\s*window\.[A-Za-z0-9_$]*\s*=' public/logic | sed ... | sort -u
                // Keeping the list is what makes no-undef able to catch a typo'd
                // function name here, which is otherwise a runtime-only failure.
                LIMIT: 'writable', allWorkflows: 'writable', applyExecFilters: 'writable', applyPreset: 'writable',
                checkN8nHealth: 'writable', clearExecFilters: 'writable', closeDetailsModal: 'writable', closeErrorModal: 'writable',
                closeWindow: 'writable', concurrencyChart: 'writable', copyErrorMessage: 'writable', currentOffset: 'writable',
                currentTab: 'writable', doughnutChart: 'writable', escapeHtml: 'writable', fetchConcurrency: 'writable',
                fetchConcurrencyDetails: 'writable', fetchDetailedError: 'writable', fetchExecutions: 'writable', fetchMetricsData: 'writable',
                fetchWithAuth: 'writable', forceDbSync: 'writable', formatExecDate: 'writable', formatTime: 'writable',
                globalSettings: 'writable', hasActiveFilters: 'writable', initCharts: 'writable', initDashboard: 'writable',
                initDateFilter: 'writable', initExecutionsHeader: 'writable', initSettings: 'writable', isFetchingExecutions: 'writable',
                isInPagesFolder: 'writable', lastPresetHours: 'writable', lastRawConcurrency: 'writable', lastTopWorkflows: 'writable',
                lineChart: 'writable', loadMoreExecutions: 'writable', logout: 'writable', parseExecDate: 'writable',
                populateDropdown: 'writable', populateExecWorkflowDropdown: 'writable', refreshData: 'writable', renderMarkdownSafely: 'writable',
                renderWorkflows: 'writable', setConcPreset: 'writable', settingsReady: 'writable', setupInfiniteScroll: 'writable',
                showError: 'writable', showErrorSnapshot: 'writable', switchTab: 'writable', toggleChat: 'writable',
                updateActiveFilterStyles: 'writable', updateConcurrencyChart: 'writable', updateDoughnutChart: 'writable',                 updateKpiCards: 'writable', updateLineChart: 'writable', userSettings: 'writable',
                // F-24. The two new shared layers and the handlers the app shell,
                // the error pages and the alert editor dispatch through.
                UI: 'writable', Viz: 'writable', ChatCore: 'writable',
                TextDecoder: 'readonly',
                // The assistant. `requestAnimationFrame` batches the streamed
                // deltas, `AbortController` drops a catalogue lookup whose
                // keystroke has already been superseded, and `hljs` is the
                // vendored highlighter, loaded on the first code block rather
                // than on page load.
                requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
                AbortController: 'readonly', hljs: 'readonly',
                ChatStore: 'writable', ChatRender: 'writable', ChatTags: 'writable',
                AssistantPanel: 'writable',
                openNavDrawer: 'writable', closeNavDrawer: 'writable', toggleNavCollapse: 'writable',
                openTrace: 'writable', closeTraceModal: 'writable', renderExecutionTrace: 'writable',
                filterRelabelled: 'writable', clearErrorFilters: 'writable', setErrorRange: 'writable',
                setFingerprintStatus: 'writable', setErrorMode: 'writable',
                addAlertHeader: 'writable', removeAlertHeader: 'writable',
                importAlertCurl: 'writable', exportAlertCurl: 'writable',
                showSettingsSection: 'writable',
                showInsightsGroup: 'writable', reloadVisibleInsights: 'writable',
                insightsReady: 'writable',
            }
        },
        rules: {
            ...js.configs.recommended.rules,
            'no-unused-vars': ['warn', { args: 'none', caughtErrorsIgnorePattern: '^(e|err|ignored)$' }],
            'no-var': 'warn',
            eqeqeq: ['warn', 'smart'],
            // Each cross-file global is declared above AND defined by exactly one
            // file — that file's `function toggleChat()` is the definition, not a
            // redeclaration of somebody else's.
            'no-redeclare': ['error', { builtinGlobals: false }]
        }
    },

    // ---- The ES modules in the browser layer ----
    // These are <script type="module"> entry points and the files they import;
    // everything else on those pages is a classic script. Parsed accordingly, or
    // ESLint rejects the file outright and stops checking it at all.
    //
    // `public/logic/roi/**` is a directory rather than a list because the ROI
    // page's modules are a set that will grow, and a list is the shape that gets
    // a new file added to it and forgotten — which does not fail loudly, it just
    // silently stops linting that file.
    {
        files: [
            'public/logic/app.js', 'public/logic/chat.js', 'public/logic/settings.js',
            'public/logic/roi.js', 'public/logic/roi/**/*.js', 'public/logic/roi/**/*.mjs'
        ],
        languageOptions: { ecmaVersion: 2022, sourceType: 'module' }
    },

    // ---- Test files ----
    {
        files: ['test/**/*.js'],
        languageOptions: {
            globals: {
                require: 'readonly', module: 'writable', process: 'readonly',
                console: 'readonly', __dirname: 'readonly', __filename: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly', fetch: 'readonly',
                Buffer: 'readonly', URL: 'readonly'
            }
        }
    }
];
