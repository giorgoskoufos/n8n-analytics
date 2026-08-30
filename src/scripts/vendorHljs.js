/**
 * Builds `public/vendor/highlight.js` from the installed package.
 *
 * ── Why this script exists ───────────────────────────────────────────────
 *
 * The CSP is `script-src 'self'` with no exceptions, for the reason written
 * beside it in server.js: Chart.js and marked used to come from jsDelivr with no
 * version pin, which meant a third party could change the code running in a page
 * that holds an auth token. So a highlighter has to be served from this origin,
 * like everything else.
 *
 * highlight.js does not ship a browser bundle on npm — only CommonJS under
 * `lib/` and a Node-only ESM shim under `es/` that re-exports it. Both are
 * unusable from a <script> tag. But every one of those CommonJS files is
 * self-contained: zero `require` calls, one `module.exports` at the end. That is
 * the whole reason this can be forty lines of concatenation rather than a
 * bundler and a build pipeline.
 *
 * ── Why not every language ───────────────────────────────────────────────
 *
 * The full pack is 200-odd grammars. What actually appears in an answer here is
 * narrow and knowable: SQL when the assistant shows a query, JSON for node
 * parameters and payload shapes, JavaScript for n8n expressions, Python for the
 * Code node, and bash and YAML because the documentation tool answers
 * self-hosting questions with docker commands and compose files. Anything else
 * renders as plain text, which is what an unhighlighted block should look like.
 *
 * Run: `node src/scripts/vendorHljs.js`
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PKG = path.join(ROOT, 'node_modules', 'highlight.js');
const OUT = path.join(ROOT, 'public', 'vendor', 'highlight.js');

const LANGUAGES = ['plaintext', 'sql', 'json', 'javascript', 'python', 'bash', 'yaml'];

function read(file) {
    const source = fs.readFileSync(file, 'utf8');
    if (source.includes('require(')) {
        // The concatenation is only valid while these files have no dependencies
        // of their own. If a future version introduces one, this must fail here
        // rather than ship a bundle that throws on load.
        throw new Error(`${path.basename(file)} now calls require() — this script needs a rethink.`);
    }
    return source;
}

const version = require(path.join(PKG, 'package.json')).version;

const parts = [];
parts.push(`/**
 * highlight.js ${version} — vendored subset. GENERATED, do not edit.
 *
 * Built by src/scripts/vendorHljs.js from node_modules/highlight.js.
 * Languages: ${LANGUAGES.join(', ')}.
 *
 * Served from this origin because the CSP allows no other script source. See
 * the script for why a browser bundle has to be assembled here.
 */
(function () {
    'use strict';

    // The smallest CommonJS the vendored files need: each one assigns to
    // \`module.exports\` and reads nothing.
    function load(factory) {
        var module = { exports: {} };
        factory(module, module.exports);
        return module.exports;
    }
`);

parts.push('    var hljs = load(function (module, exports) {\n');
parts.push(read(path.join(PKG, 'lib', 'core.js')));
parts.push('\n    });\n');

for (const lang of LANGUAGES) {
    parts.push(`\n    hljs.registerLanguage(${JSON.stringify(lang)}, load(function (module, exports) {\n`);
    parts.push(read(path.join(PKG, 'lib', 'languages', `${lang}.js`)));
    parts.push('\n    }));\n');
}

parts.push(`
    // No auto-highlighting on load: nothing on these pages is a code block until
    // the assistant writes one, and highlightAll() would walk the whole document
    // on every navigation to discover that.
    hljs.configure({ ignoreUnescapedHTML: true });
    window.hljs = hljs;
})();
`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, parts.join(''), 'utf8');

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
process.stdout.write(`Wrote ${path.relative(ROOT, OUT)} — ${kb} kB, ${LANGUAGES.length} languages.\n`);
