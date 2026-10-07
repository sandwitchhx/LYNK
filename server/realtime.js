import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { getUserFromToken, SESSION_COOKIE } from './auth.js';
import { config } from './config.js';
import { db, one, query, run, now, messageDTO } from './db.js';
import { assertConversationAccess, createNotification, ensureConversationParticipant, getConversation, getPrimarySupportUser, listTicketMessages, recipientFor, requireTicket, writeTicketHistory } from './domain.js';

const clients = new Set();
const byUser = new Map();
const ackTimers = new Map();
function toMessageDTO(row) {
  const attachments = query('SELECT id,original_filename AS filename,mime_type AS mimeType,size,sha256_hash AS sha256 FROM attachments WHERE message_id=?', row.id);
  return messageDTO({ ...row, attachments });
}

function send(socket, packet) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(packet));
}
function envelope(type, payload = {}) {
  return { type, timestamp: now(), ...payload };
}
function userSockets(userId) { return [...(byUser.get(userId) || [])].filter(socket => socket.readyState === WebSocket.OPEN); }
function isOnline(userId) { return Boolean(userId && userSockets(userId).length); }
function emitUser(userId, packet) { for (const socket of userSockets(userId)) send(socket, packet); }
function emitTicket(ticketId, packet, excludeUserId = null) {
  for (const socket of clients) {
    if (socket.readyState === WebSocket.OPEN && socket.subscriptions.has(ticketId) && socket.user.id !== excludeUserId) send(socket, packet);
  }
}
export function pushToUser(userId, packet) { emitUser(userId, envelope(packet.type, packet)); }
export function pushToTicket(ticketId, packet, excludeUserId = null) { emitTicket(ticketId, envelope(packet.type, packet), excludeUserId); }
export function closeUserConnections(userId, code = 1008, reason = 'Session ended.') {
  for (const socket of userSockets(userId)) socket.close(code, reason);
}
export function deliverStoredMessage(messageId, eventType = 'ATTACHMENT_MESSAGE') {
  const row = one('SELECT * FROM messages WHERE client_message_id=?', messageId);
  if (!row || !isOnline(row.receiver_id)) return false;
  run("UPDATE messages SET status='SENT' WHERE id=? AND status='QUEUED'", row.id);
  const current = one('SELECT * FROM messages WHERE id=?', row.id);
  emitUser(row.receiver_id, envelope(eventType, { message: toMessageDTO(current) }));
  scheduleRetry(current);
  return true;
}
function presencePacket(ticketId, userId) {
  const online = isOnline(userId);
  return envelope('PRESENCE_UPDATE', { ticketId, userId, state: online ? 'ONLINE' : 'OFFLINE' });
}
function updateTicketPresence(ticketId, userId) {
  emitTicket(ticketId, presencePacket(ticketId, userId));
}
function clearAckTimer(clientMessageId) {
  const timer = ackTimers.get(clientMessageId);
  if (timer) clearTimeout(timer);
  ackTimers.delete(clientMessageId);
}
function scheduleRetry(messageRow) {
  clearAckTimer(messageRow.client_message_id);
  const timer = setTimeout(() => retryMessage(messageRow.client_message_id), config.ackTimeoutMs);
  timer.unref?.();
  ackTimers.set(messageRow.client_message_id, timer);
}
function retryMessage(clientMessageId) {
  const message = one('SELECT * FROM messages WHERE client_message_id=?', clientMessageId);
  if (!message || !['SENT'].includes(message.status)) { clearAckTimer(clientMessageId); return; }
  if (!isOnline(message.receiver_id)) {
    run("UPDATE messages SET status='QUEUED' WHERE id=? AND status='SENT'", message.id);
    clearAckTimer(clientMessageId);
    return;
  }
  if (message.retry_count >= config.maxRetries) {
    run("UPDATE messages SET status='FAILED' WHERE id=? AND status='SENT'", message.id);
    run('INSERT OR IGNORE INTO message_acknowledgements(id,message_id,type,user_id,created_at) VALUES(?,?,?,?,?)', randomUUID(), message.id, 'FAILED', message.sender_id, now());
    emitUser(message.sender_id, envelope('MESSAGE_FAILED', { messageId: clientMessageId, ticketId: message.ticket_id, conversationId: message.conversation_id, reason: 'Acknowledgement timeout.' }));
    clearAckTimer(clientMessageId);
    return;
  }
  const nextRetry = message.retry_count + 1;
  run('UPDATE messages SET retry_count=? WHERE id=?', nextRetry, message.id);
  run('INSERT OR IGNORE INTO message_acknowledgements(id,message_id,type,user_id,created_at) VALUES(?,?,?,?,?)', randomUUID(), message.id, 'RETRY', message.sender_id, now());
  const updated = one('SELECT * FROM messages WHERE id=?', message.id);
  emitUser(message.receiver_id, envelope('MESSAGE_RETRY', { message: toMessageDTO(updated), attempt: nextRetry }));
  scheduleRetry(updated);
}
function persistAck(message, type, userId) {
  run('INSERT OR IGNORE INTO message_acknowledgements(id,message_id,type,user_id,created_at) VALUES(?,?,?,?,?)', randomUUID(), message.id, type, userId, now());
}
function acceptMessage(socket, packet) {
  if (typeof packet.messageId !== 'string' || packet.messageId.length > 100) throw new Error('messageId is required.');
  if (typeof packet.ticketId !== 'string' || typeof packet.conversationId !== 'string') throw new Error('Ticket and conversation are required.');
  if (typeof packet.content !== 'string' || !packet.content.trim() || packet.content.length > 5000) throw new Error('Message must contain 1–5000 characters.');
  if (packet.senderId && packet.senderId !== socket.user.id) throw new Error('Sender does not match the authenticated user.');
  const ticket = requireTicket(socket.user, packet.ticketId);
  const conversation = getConversation(ticket.id);
  if (conversation.id !== packet.conversationId) throw new Error('Conversation does not belong to this ticket.');
  const duplicate = one('SELECT * FROM messages WHERE client_message_id=?', packet.messageId);
  if (duplicate) {
    if (duplicate.sender_id !== socket.user.id) throw new Error('messageId is already in use.');
    send(socket, envelope('MESSAGE_ACCEPTED', { message: toMessageDTO(duplicate), duplicate: true }));
    if (duplicate.status === 'SENT' && isOnline(duplicate.receiver_id)) {
      emitUser(duplicate.receiver_id, envelope('MESSAGE', { message: toMessageDTO(duplicate) }));
      scheduleRetry(duplicate);
    }
    return;
  }
  if (socket.user.role !== 'ADMIN') assertConversationAccess(socket.user, conversation.id);
  const receiverId = recipientFor(ticket, socket.user);
  if (!receiverId) throw new Error('No support agent is available for this request.');
  if (socket.user.role !== 'STUDENT' && !ticket.assigned_admin_id) {
    const assignedAt = now();
    run("UPDATE tickets SET assigned_admin_id=?,status='ASSIGNED',updated_at=? WHERE id=? AND assigned_admin_id IS NULL", socket.user.id, assignedAt, ticket.id);
    writeTicketHistory(ticket.id, socket.user.id, 'ASSIGNED', null, socket.user.id);
    const assignedNotification = createNotification(ticket.student_id, ticket.id, 'TICKET_ASSIGNED', 'Support team assigned', `A support user is now handling ${ticket.public_id}.`);
    if (assignedNotification) emitUser(ticket.student_id, envelope('NOTIFICATION', { notification: assignedNotification }));
    emitTicket(ticket.id, envelope('TICKET_STATUS_CHANGED', { ticketId:ticket.id, status:'ASSIGNED' }));
  }
  ensureConversationParticipant(conversation.id, socket.user.id);
  ensureConversationParticipant(conversation.id, receiverId);
  const id = randomUUID();
  const sequence = one('SELECT COALESCE(MAX(sequence_number),0)+1 AS next FROM messages WHERE conversation_id=?', conversation.id).next;
  const timestamp = now();
  const status = isOnline(receiverId) ? 'SENT' : 'QUEUED';
  db.exec('BEGIN');
  try {
    run('INSERT INTO messages(id,client_message_id,conversation_id,ticket_id,sender_id,receiver_id,content,status,sequence_number,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', id, packet.messageId, conversation.id, ticket.id, socket.user.id, receiverId, packet.content.trim(), status, sequence, timestamp);
    run('UPDATE conversations SET updated_at=? WHERE id=?', timestamp, conversation.id);
    run('UPDATE tickets SET updated_at=? WHERE id=?', timestamp, ticket.id);
    const saved = one('SELECT * FROM messages WHERE id=?', id);
    persistAck(saved, 'ACCEPTED', socket.user.id);
    db.exec('COMMIT');
    const recipient = one('SELECT name FROM users WHERE id=?', receiverId);
    const notification = createNotification(receiverId, ticket.id, 'NEW_MESSAGE', 'New ticket message', `A new message is waiting on ${ticket.public_id}.`);
    if (notification) emitUser(receiverId, envelope('NOTIFICATION', { notification }));
    send(socket, envelope('MESSAGE_ACCEPTED', { message: toMessageDTO(saved) }));
    if (status === 'SENT') {
      emitUser(receiverId, envelope('MESSAGE', { message: toMessageDTO(saved) }));
      scheduleRetry(saved);
    }
    pushToTicket(ticket.id, { type: 'MESSAGE_NOTIFICATION', ticketId: ticket.id, conversationId: conversation.id, recipientName: recipient?.name }, socket.user.id);
  } catch (error) {
    db.exec('ROLLBACK');
    if (String(error.message).includes('UNIQUE constraint failed: messages.client_message_id')) {
      const saved = one('SELECT * FROM messages WHERE client_message_id=?', packet.messageId);
      if (saved?.sender_id === socket.user.id) send(socket, envelope('MESSAGE_ACCEPTED', { message: toMessageDTO(saved), duplicate: true }));
      else throw new Error('messageId is already in use.');
    } else throw error;
  }
}
function deliveryAck(socket, packet) {
  const message = one('SELECT * FROM messages WHERE client_message_id=?', packet.messageId);
  if (!message) throw new Error('Message not found.');
  if (message.receiver_id !== socket.user.id) throw new Error('Only the recipient can acknowledge delivery.');
  assertConversationAccess(socket.user, message.conversation_id);
  if (message.status === 'QUEUED') run("UPDATE messages SET status='SENT' WHERE id=?", message.id);
  const current = one('SELECT * FROM messages WHERE id=?', message.id);
  if (current.status === 'SENT') {
    const deliveredAt = now();
    run("UPDATE messages SET status='DELIVERED',delivered_at=? WHERE id=? AND status='SENT'", deliveredAt, message.id);
    persistAck(message, 'DELIVERY_ACK', socket.user.id);
    clearAckTimer(message.client_message_id);
    emitUser(message.sender_id, envelope('MESSAGE_DELIVERED', { messageId: message.client_message_id, ticketId: message.ticket_id, conversationId: message.conversation_id, deliveredAt }));
    emitUser(message.receiver_id, envelope('DELIVERY_ACK_ACCEPTED', { messageId: message.client_message_id, ticketId: message.ticket_id, conversationId: message.conversation_id, deliveredAt }));
  }
}
function readAck(socket, packet) {
  const message = one('SELECT * FROM messages WHERE client_message_id=?', packet.messageId);
  if (!message) throw new Error('Message not found.');
  if (message.receiver_id !== socket.user.id) throw new Error('Only the recipient can acknowledge reading.');
  assertConversationAccess(socket.user, message.conversation_id);
  if (message.status === 'DELIVERED') {
    const readAt = now();
    run("UPDATE messages SET status='READ',read_at=? WHERE id=? AND status='DELIVERED'", readAt, message.id);
    persistAck(message, 'READ_ACK', socket.user.id);
    emitUser(message.sender_id, envelope('MESSAGE_READ', { messageId: message.client_message_id, ticketId: message.ticket_id, conversationId: message.conversation_id, readAt }));
    emitUser(message.receiver_id, envelope('READ_ACK_ACCEPTED', { messageId: message.client_message_id, ticketId: message.ticket_id, conversationId: message.conversation_id, readAt }));
  }
}
function subscribe(socket, packet) {
  const ticket = requireTicket(socket.user, packet.ticketId);
  const conversation = getConversation(ticket.id);
  assertConversationAccess(socket.user, conversation.id);
  socket.subscriptions.add(ticket.id);
  const otherUserId = socket.user.role === 'STUDENT' ? ticket.assigned_admin_id || recipientFor(ticket, socket.user) : ticket.student_id;
  send(socket, envelope('PRESENCE_UPDATE', { ticketId: ticket.id, userId: otherUserId, state: otherUserId && isOnline(otherUserId) ? 'ONLINE' : 'OFFLINE' }));
  const after = Number(packet.afterSequence || 0);
  const messages = listTicketMessages(conversation.id).filter(message => message.sequenceNumber > after);
  send(socket, envelope('SYNC_RESPONSE', { ticketId: ticket.id, conversationId: conversation.id, messages, lastSequence: messages.at(-1)?.sequenceNumber || after }));
  deliverQueued(socket.user.id, ticket.id);
}
function deliverQueued(userId, ticketId = null) {
  const queued = query(`SELECT * FROM messages WHERE receiver_id=? AND status='QUEUED' ${ticketId ? 'AND ticket_id=?' : ''} ORDER BY conversation_id,sequence_number`, ...(ticketId ? [userId, ticketId] : [userId]));
  for (const message of queued) {
    const sockets = userSockets(userId);
    if (!sockets.length) continue;
    run("UPDATE messages SET status='SENT' WHERE id=? AND status='QUEUED'", message.id);
    const ready = one('SELECT * FROM messages WHERE id=?', message.id);
    for (const socket of sockets) send(socket, envelope('MESSAGE', { message: toMessageDTO(ready), queued: true }));
    scheduleRetry(ready);
  }
}
function setPresence(userId, state) {
  if (state === 'OFFLINE') run('UPDATE users SET last_seen=? WHERE id=?', now(), userId);
  const tickets = query('SELECT c.ticket_id FROM conversation_participants cp JOIN conversations c ON c.id=cp.conversation_id WHERE cp.user_id=?', userId);
  const ticketIds = new Set(tickets.map(item => item.ticket_id));
  for (const { id } of query('SELECT id FROM tickets WHERE assigned_admin_id=?', userId)) ticketIds.add(id);
  if (getPrimarySupportUser()?.id === userId) for (const { id } of query("SELECT id FROM tickets WHERE assigned_admin_id IS NULL AND status IN ('OPEN','ASSIGNED')")) ticketIds.add(id);
  for (const ticketId of ticketIds) updateTicketPresence(ticketId, userId);
}
function cleanup(socket) {
  clients.delete(socket);
  const sockets = byUser.get(socket.user.id);
  sockets?.delete(socket);
  if (sockets?.size === 0) {
    byUser.delete(socket.user.id);
    setPresence(socket.user.id, 'OFFLINE');
    run("UPDATE messages SET status='QUEUED' WHERE receiver_id=? AND status='SENT'", socket.user.id);
    for (const { client_message_id: id } of query("SELECT client_message_id FROM messages WHERE receiver_id=? AND status='QUEUED'", socket.user.id)) clearAckTimer(id);
  }
}
function onEvent(socket, packet) {
  try {
    switch (packet.type) {
      case 'CONNECTION_INIT':
        send(socket, envelope('CONNECTION_INIT', { userId: socket.user.id, role: socket.user.role, state: 'ONLINE' }));
        if (packet.ticketId) subscribe(socket, packet);
        break;
      case 'SUBSCRIBE': subscribe(socket, packet); break;
      case 'MESSAGE': acceptMessage(socket, packet); break;
      case 'DELIVERY_ACK': deliveryAck(socket, packet); break;
      case 'READ_ACK': readAck(socket, packet); break;
      case 'SYNC_REQUEST':
        if (packet.ticketId) subscribe(socket, packet);
        else {
          const queuedRows = query("SELECT * FROM messages WHERE receiver_id=? AND status='QUEUED' ORDER BY created_at,sequence_number", socket.user.id);
          const queued = queuedRows.map(toMessageDTO);
          send(socket, envelope('SYNC_RESPONSE', { messages: queued }));
          deliverQueued(socket.user.id);
        }
        break;
      case 'TYPING_START':
      case 'TYPING_STOP': {
        const conversation = assertConversationAccess(socket.user, packet.conversationId);
        emitTicket(conversation.ticket_id, envelope(packet.type, { ticketId: conversation.ticket_id, conversationId: conversation.id, userId: socket.user.id }), socket.user.id);
        break;
      }
      default: send(socket, envelope('ERROR', { code: 'UNKNOWN_EVENT', message: 'Unknown WebSocket event.' }));
    }
  } catch (error) {
    send(socket, envelope('ERROR', { code: 'EVENT_REJECTED', message: error.message }));
  }
}

export function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://lynk.invalid').pathname !== '/ws') { socket.destroy(); return; }
    const origin = req.headers.origin;
    if (origin && origin !== config.clientUrl) { socket.destroy(); return; }
    const rawCookie = req.headers.cookie || '';
    const token = rawCookie.split(';').map(pair => pair.trim()).find(pair => pair.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
    const user = getUserFromToken(decodeURIComponent(token || ''));
    if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => { ws.user = user; wss.emit('connection', ws, req); });
  });
  wss.on('connection', socket => {
    socket.isAlive = true;
    socket.subscriptions = new Set();
    clients.add(socket);
    if (!byUser.has(socket.user.id)) byUser.set(socket.user.id, new Set());
    byUser.get(socket.user.id).add(socket);
    run('UPDATE users SET last_seen=? WHERE id=?', now(), socket.user.id);
    send(socket, envelope('CONNECTION_INIT', { userId: socket.user.id, role: socket.user.role, state: 'ONLINE' }));
    socket.on('pong', () => { socket.isAlive = true; });
    socket.on('message', data => {
      try { onEvent(socket, JSON.parse(data.toString())); }
      catch { send(socket, envelope('ERROR', { code: 'INVALID_JSON', message: 'Event must be valid JSON.' })); }
    });
    socket.on('close', () => cleanup(socket));
    socket.on('error', () => cleanup(socket));
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) { socket.terminate(); continue; }
      socket.isAlive = false;
      socket.ping();
    }
  }, config.heartbeatIntervalMs);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
