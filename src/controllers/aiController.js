const openai = require('../config/openai');
const localDb = require('../config/localDb');
const log = require('../utils/logger').logger('AI');

// Schema for AI context (SQLite dialect)
const dbSchema = `
    Tables:
    1. workflow_entity
       - id (string)
       - name (string)
       - active (boolean)

    2. execution_entity
       - id (integer)
       - "workflowId" (string) -> Foreign key to workflow_entity.id
       - status (string: 'success', 'error', 'canceled')
       - "startedAt" (timestamp, ISO string format)
       - "stoppedAt" (timestamp, ISO string format)

    Rules:
    - This is a SQLite database. Do NOT use PostgreSQL specific syntax like EXTRACT(EPOCH FROM ...) or NOW() - INTERVAL.
    - Always wrap case-sensitive column names in double quotes (e.g., e."workflowId").
    - To find executions by workflow name, JOIN workflow_entity w ON e."workflowId" = w.id.
    - For date-specific queries, use SQLite date functions. Example: datetime("startedAt") > datetime('now', '-2 days').
    - When multiple time periods are requested as columns, use conditional aggregation: SUM(CASE WHEN ... THEN 1 ELSE 0 END).
    - Return valid SQLite syntax.
`;

const SQL_SYSTEM = `You are a strict SQLite DBA. Translate natural language to SQL using this schema:\n${dbSchema}\nRespond ONLY with the raw SQL query. No formatting, no markdown.`;

const ANSWER_SYSTEM = 'You are an analytics assistant. Answer the user based ONLY on the JSON ' +
    'database results provided. If the data has 2 or more columns, ALWAYS use a Markdown table ' +
    'for clarity. Be brief, clear, and do not mention the database or SQL in your answer.';

// ==========================================================================
// The shared half
// ==========================================================================
//
// `chat` and `chatStream` differ only in how the final answer reaches the
// browser. Everything before that — the refusal for scoped users, the input
// checks, the history, generating the SQL and the two guards on it — is the
// same pipeline and lives here once. F-24 §6 makes the same complaint about
// the two front ends; it would be an odd fix to unify those and leave the
// server holding two copies of the part that decides what SQL may run.

/**
 * The checks that can refuse a request outright.
 * @returns {{status: number, body: object} | null}
 */
function refuse(req) {
    // The assistant answers by running SQL it wrote itself against the whole
    // replica. Every other endpoint can be scoped because its query is written
    // here; this one cannot, and appending a filter to a query the model composed
    // is not something to guess at — a single subquery or UNION would step around
    // it. Until H-06 replaces free-form SQL with an allowlist the model cannot
    // leave, the honest answer for a scoped user is no answer.
    if (req.scope && !req.scope.unrestricted) {
        log.warn(`AI chat refused for scoped user ${req.user.id}.`);
        return {
            status: 403,
            body: {
                error:
                    'The AI assistant is only available to n8n owners and admins for now. ' +
                    'It queries the whole analytics database, and per-project answers are ' +
                    'not implemented yet.'
            }
        };
    }

    const userMessage = req.body.message;
    if (!userMessage) return { status: 400, body: { error: 'Message is required' } };
    if (typeof userMessage !== 'string' || userMessage.length > 2000) {
        return { status: 400, body: { error: 'Message must be a string under 2000 characters.' } };
    }
    return null;
}

async function loadContext(userId) {
    const historyRes = await localDb.query(
        'SELECT role, content FROM dashboard_chat_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 10',
        [userId]
    );
    return historyRes.rows.reverse().map((msg) => ({
        role: msg.role === 'ai' ? 'assistant' : 'user',
        content: msg.content
    }));
}

/** Writes the SQL the model produced, with the two guards that have to hold. */
async function generateSql(userMessage, chatContext) {
    const sqlPrompt = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
            { role: 'system', content: SQL_SYSTEM },
            ...chatContext,
            { role: 'user', content: userMessage }
        ],
        temperature: 0
    });

    let sql = sqlPrompt.choices[0].message.content.trim();
    sql = sql.replace(/^```sql\n?/, '').replace(/```$/, '').trim();

    // Guard 1: Only allow SELECT or WITH (CTE) statements
    const upperSql = sql.toUpperCase();
    if (!upperSql.startsWith('SELECT') && !upperSql.startsWith('WITH')) {
        const err = new Error('Only SELECT queries are allowed.');
        err.sql = sql;
        throw err;
    }
    // Guard 2: Reject any DML/DDL keywords even inside CTEs
    const dmlPattern = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|PRAGMA|DETACH|VACUUM)\b/i;
    if (dmlPattern.test(sql)) {
        const err = new Error('Destructive SQL operations are not permitted.');
        err.sql = sql;
        throw err;
    }
    return sql;
}

function answerMessages(userMessage, chatContext, rowCount, rows) {
    return [
        { role: 'system', content: ANSWER_SYSTEM },
        ...chatContext,
        {
            role: 'user',
            content: `Question: ${userMessage}\nTotal Results in DB: ${rowCount}\n` +
                `Sample Results (Top 50): ${JSON.stringify(rows)}`
        }
    ];
}

async function persist(userId, userMessage, answer, sql) {
    await localDb.execute(
        'INSERT INTO dashboard_chat_history (user_id, role, content) VALUES (?, ?, ?)',
        [userId, 'user', userMessage]
    );
    await localDb.execute(
        'INSERT INTO dashboard_chat_history (user_id, role, content, sql_used) VALUES (?, ?, ?, ?)',
        [userId, 'ai', answer, sql]
    );
}

// ==========================================================================
// Non-streaming
// ==========================================================================

exports.chat = async (req, res) => {
    const refusal = refuse(req);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const userMessage = req.body.message;
    const userId = req.user.id;

    try {
        const chatContext = await loadContext(userId);

        let generatedSql;
        try {
            generatedSql = await generateSql(userMessage, chatContext);
        } catch (guardError) {
            log.error('❌ SQL REFUSED:', guardError.sql, guardError.message);
            return res.status(400).json({
                error: 'The AI generated an invalid SQL query.',
                details: guardError.message,
                sqlUsed: guardError.sql
            });
        }

        let dbResult;
        try {
            dbResult = await localDb.query(generatedSql);
        } catch (dbError) {
            log.error('❌ SQL ERROR:', generatedSql, dbError);
            return res.status(400).json({
                error: 'The AI generated an invalid SQL query.',
                details: dbError.message,
                sqlUsed: generatedSql
            });
        }

        const rowCount = dbResult.rows.length;
        const answerPrompt = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: answerMessages(userMessage, chatContext, rowCount, dbResult.rows.slice(0, 50)),
            temperature: 0.7
        });

        const answer = answerPrompt.choices[0].message.content;
        await persist(userId, userMessage, answer, generatedSql);

        res.json({ answer, sqlUsed: generatedSql, rowCount });
    } catch (error) {
        log.error('AI Pipeline Error:', error);
        res.status(500).json({ error: 'AI communication failed.' });
    }
};

// ==========================================================================
// Streaming — F-24 §6
// ==========================================================================

/**
 * The same pipeline, delivered as it happens.
 *
 * The item asks for "streaming instead of waiting for the whole answer". The
 * wait was two model calls plus a query, and the second call is the only part
 * whose output arrives gradually — so that is the part that streams.
 *
 * The more useful consequence is the ordering. The SQL is known before the
 * answer starts, so it is sent FIRST, as its own event. §6's other item is that
 * the query is stored in `dashboard_chat_history.sql_used` and displayed
 * nowhere; here it arrives before the sentence it produced, which is the right
 * way round — a reader can see what was asked of the database while the prose
 * is still forming, and judge the answer against it rather than after it.
 *
 * Server-Sent Events over a POST, read with fetch rather than EventSource:
 * EventSource cannot set an Authorization header, and this endpoint is
 * authenticated like every other one.
 *
 * Errors after the headers are sent cannot be an HTTP status any more — the
 * response is already 200 — so they travel as an `error` event and the client
 * renders them as a failed message. An error that arrives as a silent
 * disconnection would leave the widget spinning forever.
 */
exports.chatStream = async (req, res) => {
    const refusal = refuse(req);
    if (refusal) return res.status(refusal.status).json(refusal.body);

    const userMessage = req.body.message;
    const userId = req.user.id;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Nginx buffers proxied responses by default, which turns a stream back
        // into a single delayed blob and makes this feature look broken in
        // exactly the deployments most likely to use it.
        'X-Accel-Buffering': 'no'
    });

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // A client that navigated away must not leave the model call running and
    // the rows being serialised for nobody.
    let aborted = false;
    req.on('close', () => { aborted = true; });

    try {
        const chatContext = await loadContext(userId);

        let generatedSql;
        try {
            generatedSql = await generateSql(userMessage, chatContext);
        } catch (guardError) {
            send('error', {
                error: 'The AI generated an invalid SQL query.',
                details: guardError.message,
                sqlUsed: guardError.sql
            });
            return res.end();
        }
        if (aborted) return res.end();

        // Before the answer, deliberately.
        send('sql', { sql: generatedSql });

        let dbResult;
        try {
            dbResult = await localDb.query(generatedSql);
        } catch (dbError) {
            log.error('❌ SQL ERROR:', generatedSql, dbError);
            send('error', {
                error: 'The AI generated an invalid SQL query.',
                details: dbError.message,
                sqlUsed: generatedSql
            });
            return res.end();
        }
        if (aborted) return res.end();

        const rowCount = dbResult.rows.length;
        send('rows', { rowCount });

        const stream = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: answerMessages(userMessage, chatContext, rowCount, dbResult.rows.slice(0, 50)),
            temperature: 0.7,
            stream: true
        });

        let answer = '';
        for await (const chunk of stream) {
            if (aborted) break;
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
                answer += delta;
                send('delta', { text: delta });
            }
        }

        // Not persisted if the client vanished mid-answer: a half-sentence in
        // the history is worse than no record, because the next turn feeds it
        // back to the model as something it supposedly said.
        if (aborted) return res.end();

        await persist(userId, userMessage, answer, generatedSql);
        send('done', { answer, sqlUsed: generatedSql, rowCount });
        res.end();
    } catch (error) {
        log.error('AI Pipeline Error (stream):', error);
        send('error', { error: 'AI communication failed.' });
        res.end();
    }
};

// New method to fetch history for the UI
exports.getHistory = async (req, res) => {
    try {
        const historyRes = await localDb.query(
            'SELECT role, content, sql_used, created_at FROM dashboard_chat_history WHERE user_id = ? ORDER BY created_at ASC LIMIT 50',
            [req.user.id]
        );
        res.json(historyRes.rows);
    } catch (error) {
        log.error('History Fetch Error:', error);
        res.status(500).json({ error: 'Failed to fetch chat history.' });
    }
};
