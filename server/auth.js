import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { one, run, now, safeUser } from './db.js';
import { HttpError } from './errors.js';

export const SESSION_COOKIE = 'lynk_session';
const sessionDays = 7;
const cookieOptions = {
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: 'strict',
  path: '/',
  maxAge: sessionDays * 24 * 60 * 60 * 1000
};

export function createSession(user, res) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + cookieOptions.maxAge).toISOString();
  run('INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)', id, user.id, expiresAt, now());
  const token = jwt.sign({ sub: user.id, role: user.role, sid: id }, config.jwtSecret, { expiresIn: `${sessionDays}d`, issuer: 'lynk' });
  res.cookie(SESSION_COOKIE, token, cookieOptions);
  return safeUser(user);
}

export function getUserFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { issuer: 'lynk' });
    const session = one('SELECT * FROM sessions WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?', payload.sid, payload.sub, now());
    if (!session) return null;
    const user = one('SELECT * FROM users WHERE id=?', payload.sub);
    if (!user || user.role !== payload.role) return null;
    return user;
  } catch { return null; }
}

export function revokeSession(token) {
  if (!token) return;
  try {
    const payload = jwt.verify(token, config.jwtSecret, { issuer: 'lynk', ignoreExpiration: true });
    run('UPDATE sessions SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL', now(), payload.sid, payload.sub);
  } catch { /* Expired or invalid cookies are cleared by the route regardless. */ }
}

export function authenticate(req, res, next) {
  const user = getUserFromToken(req.cookies?.[SESSION_COOKIE]);
  if (!user) return next(new HttpError(401, 'Sign in to continue.', 'UNAUTHENTICATED'));
  req.user = safeUser(user);
  req.sessionToken = req.cookies[SESSION_COOKIE];
  next();
}

export function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, 'You do not have permission to do that.', 'FORBIDDEN'));
    next();
  };
}
