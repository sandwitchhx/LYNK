import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

if (config.databasePath !== ':memory:') fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
export const db = new DatabaseSync(config.databasePath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('STUDENT','ADMIN','HELPDESK')),
  last_seen TEXT,
  notification_preferences TEXT NOT NULL DEFAULT '{"requestUpdates":true,"newMessages":true,"reminders":false}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  student_id TEXT NOT NULL REFERENCES users(id),
  assigned_admin_id TEXT REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL CHECK(priority IN ('LOW','NORMAL','HIGH','URGENT')) DEFAULT 'NORMAL',
  status TEXT NOT NULL CHECK(status IN ('OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED')) DEFAULT 'OPEN',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_participants (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  client_message_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  receiver_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','SENT','QUEUED','DELIVERED','READ','FAILED')),
  sequence_number INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  read_at TEXT,
  UNIQUE(conversation_id,sequence_number)
);
CREATE TABLE IF NOT EXISTS message_acknowledgements (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('ACCEPTED','DELIVERY_ACK','READ_ACK','RETRY','FAILED')),
  user_id TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(message_id,type,user_id)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  original_filename TEXT NOT NULL,
  stored_filename TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id TEXT REFERENCES tickets(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_history (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_student ON tickets(student_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id,revoked_at,expires_at);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee_status ON tickets(assigned_admin_id,status,updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id,sequence_number);
CREATE INDEX IF NOT EXISTS idx_messages_receiver_status ON messages(receiver_id,status,created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id,is_read,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_ticket ON ticket_history(ticket_id,created_at);
`);

export const now = () => new Date().toISOString();
export function query(sql, ...params) { return db.prepare(sql).all(...params); }
export function one(sql, ...params) { return db.prepare(sql).get(...params) || null; }
export function run(sql, ...params) { return db.prepare(sql).run(...params); }

export function safeUser(user) {
  if (!user) return null;
  return { id: user.id, name: user.name, email: user.email, role: user.role, lastSeen: user.last_seen ?? null };
}
export function ticketDTO(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id, ticketId: ticket.public_id, studentId: ticket.student_id,
    assignedAdminId: ticket.assigned_admin_id, assignedAdminName: ticket.assigned_admin_name || null,
    studentName: ticket.student_name || null, title: ticket.title, description: ticket.description,
    category: ticket.category, priority: ticket.priority, status: ticket.status,
    createdAt: ticket.created_at, updatedAt: ticket.updated_at
  };
}
export function messageDTO(message) {
  return {
    id: message.id, messageId: message.client_message_id, ticketId: message.ticket_id,
    conversationId: message.conversation_id, senderId: message.sender_id, receiverId: message.receiver_id,
    content: message.content, status: message.status, sequenceNumber: message.sequence_number,
    retryCount: message.retry_count, createdAt: message.created_at,
    deliveredAt: message.delivered_at, readAt: message.read_at,
    attachments: message.attachments || []
  };
}
