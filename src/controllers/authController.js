const bcrypt = require('bcrypt');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const userDao = require('../dao/userDao');
const { JWT_SECRET } = require('../middlewares/auth');
const log = require('../utils/logger').logger('AUTH');

// Compared against when no user matches, so a missing account costs the same time
// as a wrong password. Without it, response latency reveals which emails exist.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);


exports.login = async (req, res) => {
    const { email, password } = req.body;

    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
        const user = await userDao.findByEmail(email);

        // Always run a comparison, even with no user, to keep the timing uniform.
        const isMatch = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);

        if (!user || !isMatch) {
            return res.status(401).json({ error: 'Wrong Credentials' });
        }

        // Deactivating a user in n8n must lock them out here too. Same generic
        // message as a bad password — a disabled account isn't owed an explanation.
        if (user.disabled === true) {
            log.warn(`Login blocked for disabled n8n user: ${user.email}`);
            return res.status(401).json({ error: 'Wrong Credentials' });
        }

        // The password alone is not enough for an account that n8n protects with a
        // second factor. Accepting it here would make this dashboard the weak door
        // into the same data. Only reached once the password is already verified.
        if (user.mfaEnabled === true) {
            log.warn(`Login blocked for MFA-enabled n8n user: ${user.email}`);
            return res.status(403).json({
                error:
                    'This account has two-factor authentication enabled in n8n, which the dashboard ' +
                    'does not support yet. Use an account without 2FA, or disable it in n8n.'
            });
        }

        // jti gives every token a unique id, so individual sessions can be revoked
        // later without rotating the signing secret and logging everyone out.
        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                firstName: user.firstName,
                role: user.roleSlug || null,
                jti: crypto.randomUUID()
            },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        // Replicate user to SQLite for local dashboard reference
        const localDb = require('../config/localDb');
        await localDb.execute(
            'INSERT INTO users (id, email) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET email=excluded.email',
            [user.id, user.email]
        );

        res.json({
            message: 'Successful Login!',
            token: token,
            user: { firstName: user.firstName, lastName: user.lastName, email: user.email }
        });

    } catch (err) {
        log.error('Login Error:', err);
        res.status(500).json({ error: 'Internal server error during login' });
    }
};
