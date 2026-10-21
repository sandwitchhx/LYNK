import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { one, now, run } from './db.js';

export async function createAdminIfMissing({ name, email, password }) {
  name = name?.trim();
  email = email?.trim().toLowerCase();
  if (!name || name.length > 100) throw new Error('Set LYNK_BOOTSTRAP_ADMIN_NAME (1–100 characters).');
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Set LYNK_BOOTSTRAP_ADMIN_EMAIL to a valid email address.');
  }
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) {
    throw new Error('Set LYNK_BOOTSTRAP_ADMIN_PASSWORD (10–200 characters).');
  }

  const existing = one('SELECT role FROM users WHERE email=? COLLATE NOCASE', email);
  if (existing) {
    if (existing.role !== 'ADMIN') throw new Error(`The email ${email} already belongs to a non-admin account; no changes were made.`);
    return 'EXISTS';
  }

  const timestamp = now();
  const passwordHash = await bcrypt.hash(password, 12);
  run(
    'INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    randomUUID(), name, email, passwordHash, 'ADMIN', timestamp, timestamp
  );
  return 'CREATED';
}

export async function bootstrapAdminFromEnvironment() {
  const name = process.env.LYNK_BOOTSTRAP_ADMIN_NAME;
  const email = process.env.LYNK_BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.LYNK_BOOTSTRAP_ADMIN_PASSWORD;
  if (![name, email, password].some(value => value !== undefined)) return 'SKIPPED';
  return createAdminIfMissing({ name, email, password });
}
