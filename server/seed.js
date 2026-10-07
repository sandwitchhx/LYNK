import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { db, one, now, run } from './db.js';

if (process.env.NODE_ENV === 'production') throw new Error('Seed users are for development only.');
const users = [
  { role: 'STUDENT', name: 'Sofia Bennett', email: process.env.SEED_STUDENT_EMAIL || 'student@lynk.local', password: process.env.SEED_STUDENT_PASSWORD || 'LYNK-student-demo-123!' },
  { role: 'ADMIN', name: 'Maya Chen', email: process.env.SEED_ADMIN_EMAIL || 'admin@lynk.local', password: process.env.SEED_ADMIN_PASSWORD || 'LYNK-admin-demo-123!' },
  { role: 'HELPDESK', name: 'Jordan Lee', email: process.env.SEED_HELPDESK_EMAIL || 'helpdesk@lynk.local', password: process.env.SEED_HELPDESK_PASSWORD || 'LYNK-helpdesk-demo-123!' }
];
for (const user of users) {
  if (one('SELECT id FROM users WHERE email=?', user.email)) continue;
  const timestamp = now();
  run('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', randomUUID(), user.name, user.email, await bcrypt.hash(user.password, 12), user.role, timestamp, timestamp);
  console.log(`Created ${user.role}: ${user.email}`);
}
console.log('Development accounts ready. Configure SEED_* credentials to override the documented local demo defaults.');
