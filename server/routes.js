import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { config } from './config.js';
import { db, one, query, run, now, safeUser, ticketDTO, messageDTO } from './db.js';
import { authenticate, allowRoles, createSession, getUserFromToken, revokeSession, SESSION_COOKIE } from './auth.js';
import { asyncRoute, HttpError, requireFields } from './errors.js';
import { assertConversationAccess, createNotification, ensureConversationParticipant, findTicket, getConversation, listTicketMessages, mayAccessTicket, recipientFor, requireTicket, ticketWithCounts, writeTicketHistory } from './domain.js';
import { closeUserConnections, deliverStoredMessage, pushToTicket, pushToUser } from './realtime.js';

export const api = Router();
const authAttempts = new Map();
const allowedPriorities = new Set(['LOW','NORMAL','HIGH','URGENT']);
const allowedStatuses = new Set(['OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED']);
const transitionMap = { OPEN: ['ASSIGNED','CLOSED'], ASSIGNED: ['IN_PROGRESS','OPEN','RESOLVED','CLOSED'], IN_PROGRESS: ['RESOLVED','ASSIGNED','CLOSED'], RESOLVED: ['CLOSED','IN_PROGRESS'], CLOSED: [] };
function publicNotification(row) {
  return { id: row.id, ticketId: row.ticket_id, type: row.type, title: row.title, message: row.message, isRead: Boolean(row.is_read), createdAt: row.created_at };
}
function notify(userId, ticketId, type, title, message) {
  const record = createNotification(userId, ticketId, type, title, message);
  if (record) pushToUser(userId, { type: 'NOTIFICATION', notification: record });
  return record;
}
function notifyTicket(ticket, type, title, message, except = []) {
  const recipients = new Set([ticket.student_id, ticket.assigned_admin_id].filter(Boolean));
  if (ticket.status === 'OPEN' && !ticket.assigned_admin_id) {
    for (const { id } of query("SELECT id FROM users WHERE role IN ('ADMIN','HELPDESK')")) recipients.add(id);
  }
  for (const userId of recipients) if (!except.includes(userId)) notify(userId, ticket.id, type, title, message);
}
function publicUserById(id) { return safeUser(one('SELECT * FROM users WHERE id=?', id)); }
function ticketListFor(user) {
  if (user.role === 'STUDENT') return query(`SELECT t.*,u.name AS student_name,a.name AS assigned_admin_name FROM tickets t JOIN users u ON u.id=t.student_id LEFT JOIN users a ON a.id=t.assigned_admin_id WHERE t.student_id=? ORDER BY t.updated_at DESC`, user.id);
  if (user.role === 'ADMIN') return query(`SELECT t.*,u.name AS student_name,a.name AS assigned_admin_name FROM tickets t JOIN users u ON u.id=t.student_id LEFT JOIN users a ON a.id=t.assigned_admin_id ORDER BY t.updated_at DESC`);
  return query(`SELECT t.*,u.name AS student_name,a.name AS assigned_admin_name FROM tickets t JOIN users u ON u.id=t.student_id LEFT JOIN users a ON a.id=t.assigned_admin_id WHERE t.assigned_admin_id IS NULL OR t.assigned_admin_id=? ORDER BY t.updated_at DESC`, user.id);
}
function maybeNotifyPreference(userId) {
  try { return JSON.parse(one('SELECT notification_preferences FROM users WHERE id=?', userId)?.notification_preferences || '{}'); }
  catch { return {}; }
}
function limitAuthentication(req, res, next) {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const currentTime = Date.now();
  const record = authAttempts.get(key);
  if (!record || currentTime - record.startedAt > 15 * 60 * 1000) {
    authAttempts.set(key, { startedAt:currentTime, count:1 });
    return next();
  }
  if (record.count >= 20) return next(new HttpError(429, 'Too many authentication attempts. Try again later.', 'RATE_LIMITED'));
  record.count += 1;
  next();
}

api.post('/auth/register', limitAuthentication, asyncRoute(async (req, res) => {
  requireFields(req.body, ['name','email','password']);
  const name = req.body.name.trim();
  const email = req.body.email.trim().toLowerCase();
  const password = req.body.password;
  if (name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid name and email address.', 'VALIDATION_ERROR');
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw new HttpError(400, 'Password must be at least 10 characters.', 'VALIDATION_ERROR');
  if (one('SELECT id FROM users WHERE email=?', email)) throw new HttpError(409, 'An account with that email already exists.', 'EMAIL_EXISTS');
  const id = randomUUID();
  const timestamp = now();
  const passwordHash = await bcrypt.hash(password, 12);
  run("INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,'STUDENT',?,?)", id, name, email, passwordHash, timestamp, timestamp);
  const user = one('SELECT * FROM users WHERE id=?', id);
  res.status(201).json({ user: createSession(user, res) });
}));

api.post('/auth/login', limitAuthentication, asyncRoute(async (req, res) => {
  requireFields(req.body, ['email','password']);
  if (req.body.portal !== undefined && !['STUDENT','STAFF'].includes(req.body.portal)) throw new HttpError(400, 'Choose the student or staff portal.', 'VALIDATION_ERROR');
  const user = one('SELECT * FROM users WHERE email=? COLLATE NOCASE', req.body.email.trim());
  const valid = user && await bcrypt.compare(req.body.password, user.password_hash);
  if (!valid) throw new HttpError(401, 'Email or password is incorrect.', 'INVALID_CREDENTIALS');
  if (req.body.portal === 'STUDENT' && user.role !== 'STUDENT') throw new HttpError(403, 'This account belongs in the admin and staff portal.', 'PORTAL_MISMATCH');
  if (req.body.portal === 'STAFF' && !['ADMIN','HELPDESK'].includes(user.role)) throw new HttpError(403, 'This account belongs in the student portal.', 'PORTAL_MISMATCH');
  run('UPDATE users SET updated_at=? WHERE id=?', now(), user.id);
  res.json({ user: createSession(user, res) });
}));
api.post('/auth/logout', (req, res) => {
  const userId = getUserFromToken(req.cookies?.[SESSION_COOKIE])?.id;
  revokeSession(req.cookies?.[SESSION_COOKIE]);
  if (userId) closeUserConnections(userId);
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: 'strict', path: '/' });
  res.json({ ok: true });
});
api.get('/auth/me', authenticate, (req, res) => res.json({ user: req.user }));
api.get('/users/me', authenticate, (req, res) => res.json({ user: req.user }));
api.patch('/users/me/preferences', authenticate, (req, res) => {
  const { requestUpdates, newMessages, reminders, reducedMotion } = req.body || {};
  for (const value of [requestUpdates,newMessages,reminders,reducedMotion]) if (value !== undefined && typeof value !== 'boolean') throw new HttpError(400, 'Preferences must be boolean values.', 'VALIDATION_ERROR');
  const current = maybeNotifyPreference(req.user.id);
  const preferences = { ...current, ...Object.fromEntries(Object.entries({ requestUpdates,newMessages,reminders,reducedMotion }).filter(([,value]) => value !== undefined)) };
  run('UPDATE users SET notification_preferences=?,updated_at=? WHERE id=?', JSON.stringify(preferences), now(), req.user.id);
  res.json({ preferences });
});
api.get('/users/me/preferences', authenticate, (req, res) => res.json({ preferences: maybeNotifyPreference(req.user.id) }));
api.patch('/users/me', authenticate, asyncRoute(async (req, res) => {
  const { name, password } = req.body || {};
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 100)) throw new HttpError(400, 'Name must be between 1 and 100 characters.', 'VALIDATION_ERROR');
  if (password !== undefined && (typeof password !== 'string' || password.length < 10 || password.length > 200)) throw new HttpError(400, 'Password must be at least 10 characters.', 'VALIDATION_ERROR');
  if (name !== undefined) run('UPDATE users SET name=?,updated_at=? WHERE id=?', name.trim(), now(), req.user.id);
  if (password !== undefined) run('UPDATE users SET password_hash=?,updated_at=? WHERE id=?', await bcrypt.hash(password, 12), now(), req.user.id);
  res.json({ user: safeUser(one('SELECT * FROM users WHERE id=?', req.user.id)) });
}));

api.get('/dashboard', authenticate, (req, res) => {
  const tickets = ticketListFor(req.user);
  const counts = Object.fromEntries(['OPEN','ASSIGNED','IN_PROGRESS','RESOLVED','CLOSED'].map(status => [status, tickets.filter(ticket => ticket.status === status).length]));
  const unreadMessages = one("SELECT count(*) AS total FROM messages WHERE receiver_id=? AND status IN ('SENT','QUEUED','DELIVERED')", req.user.id)?.total || 0;
  const notifications = one('SELECT count(*) AS total FROM notifications WHERE user_id=? AND is_read=0', req.user.id)?.total || 0;
  const recent = tickets.slice(0, 5).map(ticket => ticketWithCounts(ticket));
  const recentMessage = one(`SELECT m.*,t.public_id FROM messages m JOIN tickets t ON t.id=m.ticket_id
    WHERE m.sender_id=? OR m.receiver_id=? ORDER BY m.created_at DESC LIMIT 1`, req.user.id, req.user.id);
  const recentSender = recentMessage ? one('SELECT name FROM users WHERE id=?', recentMessage.sender_id) : null;
  res.json({ role: req.user.role, counts, tickets: recent, unreadMessages, unreadNotifications: notifications, recentMessage: recentMessage ? { ...messageDTO(recentMessage), ticketPublicId: recentMessage.public_id, senderName: recentSender?.name || '' } : null });
});

api.get('/tickets', authenticate, (req, res) => {
  let tickets = ticketListFor(req.user);
  const search = String(req.query.search || '').trim().toLowerCase();
  if (req.query.status) tickets = tickets.filter(ticket => ticket.status === String(req.query.status).toUpperCase());
  if (req.query.priority) tickets = tickets.filter(ticket => ticket.priority === String(req.query.priority).toUpperCase());
  if (req.query.category) tickets = tickets.filter(ticket => ticket.category.toLowerCase() === String(req.query.category).toLowerCase());
  if (search) tickets = tickets.filter(ticket => `${ticket.public_id} ${ticket.title} ${ticket.category} ${ticket.priority} ${ticket.status} ${ticket.assigned_admin_name || ''} ${ticket.student_name || ''}`.toLowerCase().includes(search));
  res.json({ tickets: tickets.map(ticketWithCounts) });
});
api.post('/tickets', authenticate, allowRoles('STUDENT'), (req, res, next) => {
  try {
    requireFields(req.body, ['title','description','category']);
    const title = req.body.title.trim();
    const description = req.body.description.trim();
    const category = req.body.category.trim();
    const priority = String(req.body.priority || 'NORMAL').toUpperCase();
    if (title.length > 160 || description.length > 10000 || category.length > 80) throw new HttpError(400, 'Request fields exceed the allowed length.', 'VALIDATION_ERROR');
    if (!allowedPriorities.has(priority)) throw new HttpError(400, 'Choose a valid priority.', 'VALIDATION_ERROR');
    const id = randomUUID();
    const conversationId = randomUUID();
    const publicId = `LY-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random()*90+10)}`;
    const timestamp = now();
    db.exec('BEGIN');
    try {
      run('INSERT INTO tickets(id,public_id,student_id,title,description,category,priority,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,\'OPEN\',?,?)', id, publicId, req.user.id, title, description, category, priority, timestamp, timestamp);
      run('INSERT INTO conversations(id,ticket_id,created_at,updated_at) VALUES(?,?,?,?)', conversationId, id, timestamp, timestamp);
      run('INSERT INTO conversation_participants(conversation_id,user_id,added_at) VALUES(?,?,?)', conversationId, req.user.id, timestamp);
      writeTicketHistory(id, req.user.id, 'CREATED', null, 'OPEN');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    const ticket = findTicket(id);
    notifyTicket(ticket, 'NEW_TICKET', 'New support request', `${publicId} · ${title}`);
    for (const { id: adminId } of query("SELECT id FROM users WHERE role IN ('ADMIN','HELPDESK')")) pushToUser(adminId, { type: 'TICKET_CREATED', ticket: ticketWithCounts(ticket) });
    res.status(201).json({ ticket: { ...ticketWithCounts(ticket), conversationId } });
  } catch (error) { next(error); }
});
api.get('/tickets/:id', authenticate, (req, res) => {
  const ticket = requireTicket(req.user, req.params.id);
  const conversation = getConversation(ticket.id);
  const history = query('SELECT h.*,u.name AS actor_name FROM ticket_history h JOIN users u ON u.id=h.actor_id WHERE h.ticket_id=? ORDER BY h.created_at', ticket.id).map(row => ({ id: row.id, actorId: row.actor_id, actorName: row.actor_name, type: row.event_type, from: row.old_value, to: row.new_value, createdAt: row.created_at }));
  const attachments = query('SELECT a.* FROM attachments a WHERE a.ticket_id=? ORDER BY a.created_at', ticket.id).map(row => ({ id: row.id, messageId: row.message_id, filename: row.original_filename, mimeType: row.mime_type, size: row.size, sha256: row.sha256_hash, createdAt: row.created_at }));
  const notifications = query('SELECT * FROM notifications WHERE user_id=? AND ticket_id=? ORDER BY created_at DESC', req.user.id, ticket.id).map(publicNotification);
  res.json({ ticket: { ...ticketWithCounts(ticket), conversationId: conversation.id }, history, attachments, notifications });
});
api.patch('/tickets/:id', authenticate, allowRoles('ADMIN','HELPDESK'), (req, res) => {
  const ticket = requireTicket(req.user, req.params.id);
  let assignedAdminId = ticket.assigned_admin_id;
  let status = ticket.status;
  let priority = ticket.priority;
  if (req.body.assignedAdminId !== undefined) {
    assignedAdminId = req.body.assignedAdminId;
    if (req.user.role === 'HELPDESK' && assignedAdminId !== req.user.id) throw new HttpError(403, 'Helpdesk users may assign a ticket only to themselves.', 'FORBIDDEN');
    if (assignedAdminId !== null) {
      const assignee = one('SELECT id,role FROM users WHERE id=?', assignedAdminId);
      if (!assignee || !['ADMIN','HELPDESK'].includes(assignee.role)) throw new HttpError(400, 'Assignee must be an authorized support user.', 'VALIDATION_ERROR');
    }
    if (assignedAdminId && ['RESOLVED','CLOSED'].includes(ticket.status)) throw new HttpError(409, 'Reopen this ticket before assigning it.', 'INVALID_TRANSITION');
    if (assignedAdminId && !ticket.assigned_admin_id) status = 'ASSIGNED';
    if (assignedAdminId === null && ticket.assigned_admin_id) status = 'OPEN';
    if (assignedAdminId && ticket.assigned_admin_id && assignedAdminId !== ticket.assigned_admin_id && status === 'IN_PROGRESS') status = 'ASSIGNED';
  }
  if (req.body.status !== undefined) {
    const nextStatus = String(req.body.status).toUpperCase();
    if (!allowedStatuses.has(nextStatus)) throw new HttpError(400, 'Choose a valid ticket status.', 'VALIDATION_ERROR');
    if (nextStatus !== status && !transitionMap[status].includes(nextStatus)) throw new HttpError(409, `Cannot change status from ${status} to ${nextStatus}.`, 'INVALID_TRANSITION');
    status = nextStatus;
    if (status === 'OPEN') assignedAdminId = null;
  }
  if (req.body.priority !== undefined) {
    priority = String(req.body.priority).toUpperCase();
    if (!allowedPriorities.has(priority)) throw new HttpError(400, 'Choose a valid priority.', 'VALIDATION_ERROR');
  }
  const timestamp = now();
  run('UPDATE tickets SET assigned_admin_id=?,status=?,priority=?,updated_at=? WHERE id=?', assignedAdminId, status, priority, timestamp, ticket.id);
  if (ticket.assigned_admin_id !== assignedAdminId) {
    writeTicketHistory(ticket.id, req.user.id, 'ASSIGNED', ticket.assigned_admin_id, assignedAdminId);
    const conversationId = getConversation(ticket.id).id;
    if (ticket.assigned_admin_id) run('DELETE FROM conversation_participants WHERE conversation_id=? AND user_id=?', conversationId, ticket.assigned_admin_id);
    if (assignedAdminId) ensureConversationParticipant(conversationId, assignedAdminId);
    const assignee = assignedAdminId ? one('SELECT name FROM users WHERE id=?', assignedAdminId)?.name : 'the support queue';
    notify(ticket.student_id, ticket.id, 'TICKET_ASSIGNED', 'Support team assigned', `${ticket.public_id} is assigned to ${assignee}.`);
  }
  if (ticket.status !== status) {
    writeTicketHistory(ticket.id, req.user.id, 'STATUS_CHANGED', ticket.status, status);
    notifyTicket({ ...ticket, status, assigned_admin_id: assignedAdminId }, status === 'RESOLVED' ? 'TICKET_RESOLVED' : 'TICKET_STATUS_CHANGED', status === 'RESOLVED' ? 'Request resolved' : 'Request status updated', `${ticket.public_id} is now ${status.replaceAll('_',' ').toLowerCase()}.`);
  }
  if (ticket.priority !== priority) writeTicketHistory(ticket.id, req.user.id, 'PRIORITY_CHANGED', ticket.priority, priority);
  const updated = findTicket(ticket.id);
  pushToTicket(ticket.id, { type: ticket.status !== status ? 'TICKET_STATUS_CHANGED' : 'TICKET_UPDATED', ticket: ticketWithCounts(updated) });
  res.json({ ticket: ticketWithCounts(updated) });
});

api.get('/tickets/:id/conversation', authenticate, (req, res) => {
  const ticket = requireTicket(req.user, req.params.id);
  const conversation = getConversation(ticket.id);
  assertConversationAccess(req.user, conversation.id);
  res.json({ conversation: { id: conversation.id, ticketId: ticket.id, createdAt: conversation.created_at, updatedAt: conversation.updated_at }, messages: listTicketMessages(conversation.id) });
});
api.get('/conversations/:id/messages', authenticate, (req, res) => {
  const conversation = assertConversationAccess(req.user, req.params.id);
  res.json({ messages: listTicketMessages(conversation.id) });
});
api.get('/tickets/:id/history', authenticate, (req, res) => {
  const ticket = requireTicket(req.user, req.params.id);
  const history = query('SELECT h.*,u.name AS actor_name FROM ticket_history h JOIN users u ON u.id=h.actor_id WHERE h.ticket_id=? ORDER BY h.created_at', ticket.id);
  res.json({ history });
});

api.get('/notifications', authenticate, (req, res) => {
  const notifications = query('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', req.user.id).map(publicNotification);
  res.json({ notifications, unread: notifications.filter(item => !item.isRead).length });
});
api.patch('/notifications/read-all', authenticate, (req, res) => {
  run('UPDATE notifications SET is_read=1 WHERE user_id=? AND is_read=0', req.user.id);
  res.json({ ok: true });
});
api.patch('/notifications/:id/read', authenticate, (req, res) => {
  const notification = one('SELECT * FROM notifications WHERE id=? AND user_id=?', req.params.id, req.user.id);
  if (!notification) throw new HttpError(404, 'Notification not found.', 'NOT_FOUND');
  run('UPDATE notifications SET is_read=1 WHERE id=?', notification.id);
  res.json({ notification: publicNotification({ ...notification, is_read: 1 }) });
});

const allowedFiles = new Map([
  ['.pdf','application/pdf'],['.png','image/png'],['.jpg','image/jpeg'],['.jpeg','image/jpeg'],['.webp','image/webp'],['.txt','text/plain']
]);
function validFileSignature(buffer, extension) {
  if (extension === '.pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  if (extension === '.png') return buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (extension === '.jpg' || extension === '.jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (extension === '.webp') return buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP';
  if (extension === '.txt') return !buffer.includes(0);
  return false;
}
fs.mkdirSync(config.uploadDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({ destination: config.uploadDir, filename: (req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`) }),
  limits: { fileSize: config.maxFileSize, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedFiles.has(ext) || allowedFiles.get(ext) !== file.mimetype) return cb(new HttpError(415, 'Supported attachment types: PDF, PNG, JPG, WEBP, and TXT.', 'UNSUPPORTED_FILE'));
    cb(null, true);
  }
});
api.post('/tickets/:id/attachments', authenticate, upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Choose a file to upload.', 'VALIDATION_ERROR');
  try {
    const ticket = requireTicket(req.user, req.params.id);
    const conversation = getConversation(ticket.id);
    assertConversationAccess(req.user, conversation.id);
    const originalFilename = path.basename(req.file.originalname).replace(/[\u0000-\u001f]/g, '').slice(0, 180) || 'attachment';
    const bytes = await fs.promises.readFile(req.file.path);
    if (!validFileSignature(bytes, path.extname(originalFilename).toLowerCase())) throw new HttpError(415, 'The file contents do not match the declared file type.', 'INVALID_FILE_CONTENT');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const receiverId = recipientFor(ticket, req.user);
    if (!receiverId) throw new HttpError(503, 'No support user is available for this request.', 'NO_RECIPIENT');
    ensureConversationParticipant(conversation.id, req.user.id);
    ensureConversationParticipant(conversation.id, receiverId);
    const messageId = randomUUID();
    const dbId = randomUUID();
    const attachmentId = randomUUID();
    const sequence = one('SELECT COALESCE(MAX(sequence_number),0)+1 AS next FROM messages WHERE conversation_id=?', conversation.id).next;
    const timestamp = now();
    const content = String(req.body.caption || '').trim() || `Attachment: ${originalFilename}`;
    db.exec('BEGIN');
    try {
      run("INSERT INTO messages(id,client_message_id,conversation_id,ticket_id,sender_id,receiver_id,content,status,sequence_number,created_at) VALUES(?,?,?,?,?,?,?,'QUEUED',?,?)", dbId, messageId, conversation.id, ticket.id, req.user.id, receiverId, content, sequence, timestamp);
      run('INSERT INTO attachments(id,ticket_id,message_id,original_filename,stored_filename,mime_type,size,sha256_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)', attachmentId, ticket.id, dbId, originalFilename, path.basename(req.file.filename), req.file.mimetype, req.file.size, sha256, timestamp);
      run('UPDATE conversations SET updated_at=? WHERE id=?', timestamp, conversation.id);
      run('COMMIT');
    } catch (error) { run('ROLLBACK'); throw error; }
    const saved = one('SELECT m.*, json_group_array(json_object(\'id\',a.id,\'filename\',a.original_filename,\'mimeType\',a.mime_type,\'size\',a.size,\'sha256\',a.sha256_hash)) AS attachments_json FROM messages m JOIN attachments a ON a.message_id=m.id WHERE m.id=? GROUP BY m.id', dbId);
    const message = messageDTO({ ...saved, attachments: JSON.parse(saved.attachments_json) });
    notify(receiverId, ticket.id, 'ATTACHMENT_RECEIVED', 'Attachment received', `A file was added to ${ticket.public_id}.`);
    deliverStoredMessage(messageId, 'ATTACHMENT_MESSAGE');
    res.status(201).json({ message, attachment: { id: attachmentId, sha256, integrity: 'VERIFIED' } });
  } catch (error) {
    await fs.promises.unlink(req.file.path).catch(() => {});
    throw error;
  }
}));
api.get('/attachments/:id', authenticate, asyncRoute(async (req, res) => {
  const attachment = one('SELECT * FROM attachments WHERE id=?', req.params.id);
  if (!attachment) throw new HttpError(404, 'Attachment not found.', 'NOT_FOUND');
  const ticket = requireTicket(req.user, attachment.ticket_id);
  const filePath = path.join(config.uploadDir, path.basename(attachment.stored_filename));
  const bytes = await fs.promises.readFile(filePath).catch(() => { throw new HttpError(404, 'Attachment file is unavailable.', 'FILE_NOT_FOUND'); });
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== attachment.sha256_hash) throw new HttpError(409, 'Attachment integrity check failed.', 'INTEGRITY_FAILED');
  res.setHeader('X-Integrity-Status', 'VERIFIED');
  res.download(filePath, attachment.original_filename);
}));
api.post('/attachments/:id/verify', authenticate, asyncRoute(async (req, res) => {
  const attachment = one('SELECT * FROM attachments WHERE id=?', req.params.id);
  if (!attachment) throw new HttpError(404, 'Attachment not found.', 'NOT_FOUND');
  requireTicket(req.user, attachment.ticket_id);
  const filePath = path.join(config.uploadDir, path.basename(attachment.stored_filename));
  const bytes = await fs.promises.readFile(filePath).catch(() => { throw new HttpError(404, 'Attachment file is unavailable.', 'FILE_NOT_FOUND'); });
  const actual = createHash('sha256').update(bytes).digest('hex');
  const verified = actual === attachment.sha256_hash;
  res.status(verified ? 200 : 409).json({ integrity: verified ? 'VERIFIED' : 'FAILED', expectedSha256: attachment.sha256_hash, actualSha256: actual });
}));

api.get('/admin/users', authenticate, allowRoles('ADMIN','HELPDESK'), (req, res) => {
  const users = query("SELECT id,name,email,role,last_seen,created_at FROM users WHERE role IN ('ADMIN','HELPDESK') ORDER BY name");
  res.json({ users: users.map(safeUser) });
});
api.post('/admin/users', authenticate, allowRoles('ADMIN'), asyncRoute(async (req, res) => {
  requireFields(req.body, ['name','email','password','role']);
  const name = req.body.name.trim();
  const email = req.body.email.trim().toLowerCase();
  const { password, role } = req.body;
  if (!name || name.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid staff name and email address.', 'VALIDATION_ERROR');
  if (!['ADMIN','HELPDESK'].includes(role)) throw new HttpError(400, 'Staff role must be Admin or Helpdesk.', 'VALIDATION_ERROR');
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) throw new HttpError(400, 'Password must be at least 10 characters.', 'VALIDATION_ERROR');
  if (one('SELECT id FROM users WHERE email=?', email)) throw new HttpError(409, 'An account with that email already exists.', 'EMAIL_EXISTS');
  const id = randomUUID();
  const timestamp = now();
  const passwordHash = await bcrypt.hash(password, 12);
  run('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, name, email, passwordHash, role, timestamp, timestamp);
  res.status(201).json({ user: publicUserById(id) });
}));

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(status).json({ error: { code: error.code, message: error.code === 'LIMIT_FILE_SIZE' ? 'The attachment exceeds the configured file size limit.' : 'The attachment could not be uploaded.' } });
  }
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) console.error('Request failed:', error.message);
  return res.status(status).json({ error: { code: error.code || 'INTERNAL_ERROR', message: status >= 500 ? 'The request could not be completed.' : error.message } });
}
