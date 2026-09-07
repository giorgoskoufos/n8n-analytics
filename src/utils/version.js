/**
 * What version of this dashboard is running (B-7).
 *
 * Read once at require time and frozen. The answer cannot change while the
 * process lives, and this is called from a boot log line, an unauthenticated
 * endpoint and a settings panel — three callers that should not each be
 * re-reading a file to learn the same constant.
 *
 * `package.json` is the single source of truth for the number. The release
 * workflow also passes the tag in as a build arg so it can be stamped onto the
 * image label, but it is NOT read back here: two sources for one fact is a
 * fact that eventually disagrees with itself, and an image whose label and
 * endpoint report different versions is worse than one that reports neither.
 * CI asserts the tag and package.json match instead, which fails loudly at
 * release time rather than quietly in a bug report.
 *
 * The commit is the exception — it genuinely is not knowable from the source
 * tree, only from whatever built it.
 */

const pkg = require('../../package.json');

const info = Object.freeze({
    version: pkg.version,
    // Short form: nobody pastes 40 characters into an issue, and 7 is what
    // GitHub links resolve.
    commit: (process.env.GIT_SHA || '').slice(0, 7) || 'unknown',
    node: process.version
});

/** One line, for the boot log and for anyone reporting a problem. */
function banner() {
    return `v${info.version} (commit ${info.commit}, node ${info.node})`;
}

module.exports = { info, banner };
