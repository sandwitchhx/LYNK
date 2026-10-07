import { randomUUID } from 'node:crypto';
import { one, query, run, now, ticketDTO, messageDTO } from './db.js';
import { HttpError } from './errors.js';

export function findTicket(id) {
  return one(`SELECT t.*, s.name AS student_name, a.name AS assigned_admin_name
    FROM tickets t JOIN users s ON s.id=t.student_id
    LEFT JOIN users a ON a.id=t.assigned_admin_id WHERE t.id=? OR t.public_id=?`, id, id);
}

export function mayAccessTicket(user, ticket) {
  if (!user || !ticket) return false;
  if (user.role === 'STUDENT') return ticket.student_id === user.id;
  if (user.role === 'ADMIN') return true;
  return user.role === 'HELPDESK' && (!ticket.assigned_admin_id || ticket.assigned_admin_id === user.id);
}
export function requireTicket(user, id) {
  const ticket = findTicket(id);
  if (!ticket) throw new HttpError(404, 'Ticket not found.', 'NOT_FOUND');
  if (!mayAccessTicket(user, ticket)) throw new HttpError(403, 'You are not authorized to access this ticket.', 'FORBIDDEN');
  return ticket;
}
export function getConversation(ticketId) {
  const conversation = one('SELECT * FROM conversations WHERE ticket_id=?', ticketId);
  if (!conversation) throw new HttpError(404, 'Conversation not found.', 'NOT_FOUND');
  return conversation;
}
export function assertConversationAccess(user, conversationId) {
  const conversation = one('SELECT * FROM conversations WHERE id=?', conversationId);
  if (!conversation) throw new HttpError(404, 'Conversation not found.', 'NOT_FOUND');
  const ticket = requireTicket(user, conversation.ticket_id);
  const participant = one('SELECT 1 AS allowed FROM conversation_participants WHERE conversation_id=? AND user_id=?', conversation.id, user.id);
  if (user.role === 'HELPDESK' && !mayAccessTicket(user, ticket)) throw new HttpError(403, 'This ticket is not assigned to your support account.', 'FORBIDDEN');
  if (user.role === 'STUDENT' && ticket.student_id !== user.id) throw new HttpError(403, 'You are not a participant in this conversation.', 'FORBIDDEN');
  if (user.role === 'STUDENT' && !participant) throw new HttpError(403, 'You are not a participant in this conversation.', 'FORBIDDEN');
  return conversation;
}
export function getPrimarySupportUser() {
  return one("SELECT id FROM users WHERE role IN ('ADMIN','HELPDESK') ORDER BY CASE role WHEN 'ADMIN' THEN 0 ELSE 1 END,created_at LIMIT 1");
}
export function recipientFor(ticket, sender) {
  if (sender.role === 'STUDENT') {
    return ticket.assigned_admin_id || getPrimarySupportUser()?.id || null;
  }
  return ticket.student_id;
}
export function ensureConversationParticipant(conversationId, userId) {
  if (!userId) return;
  run('INSERT OR IGNORE INTO conversation_participants(conversation_id,user_id,added_at) VALUES(?,?,?)', conversationId, userId, now());
}
export function writeTicketHistory(ticketId, actorId, eventType, oldValue = null, newValue = null) {
  run('INSERT INTO ticket_history(id,ticket_id,actor_id,event_type,old_value,new_value,created_at) VALUES(?,?,?,?,?,?,?)', randomUUID(), ticketId, actorId, eventType, oldValue, newValue, now());
}
export function createNotification(userId, ticketId, type, title, message) {
  if (!userId) return null;
  const user = one('SELECT notification_preferences FROM users WHERE id=?', userId);
  if (user) {
    let preferences = {};
    try { preferences = JSON.parse(user.notification_preferences); } catch { /* Use defaults. */ }
    if (type === 'NEW_MESSAGE' && preferences.newMessages === false) return null;
    if (type !== 'NEW_MESSAGE' && preferences.requestUpdates === false) return null;
  }
  const record = { id: randomUUID(), userId, ticketId, type, title, message, isRead: false, createdAt: now() };
  run('INSERT INTO notifications(id,user_id,ticket_id,type,title,message,created_at) VALUES(?,?,?,?,?,?,?)', record.id, userId, ticketId, type, title, message, record.createdAt);
  return record;
}
export function listTicketMessages(conversationId) {
  return query(`SELECT m.*, COALESCE(json_group_array(json_object(
      'id',a.id,'filename',a.original_filename,'mimeType',a.mime_type,'size',a.size,'sha256',a.sha256_hash
    )) FILTER (WHERE a.id IS NOT NULL),'[]') AS attachments_json
    FROM messages m LEFT JOIN attachments a ON a.message_id=m.id
    WHERE m.conversation_id=? GROUP BY m.id ORDER BY m.sequence_number`, conversationId).map(row => {
    let attachments = [];
    try { attachments = JSON.parse(row.attachments_json); } catch { /* No attachment metadata. */ }
    return messageDTO({ ...row, attachments });
  });
}
export function ticketWithCounts(ticket) {
  const dto = ticketDTO(ticket);
  const conv = one('SELECT id FROM conversations WHERE ticket_id=?', ticket.id);
  dto.conversationId = conv?.id || null;
  const latest = one('SELECT content,status,created_at,sender_id FROM messages WHERE ticket_id=? ORDER BY sequence_number DESC LIMIT 1', ticket.id);
  dto.lastMessage = latest ? { content: latest.content, status: latest.status, createdAt: latest.created_at, senderId: latest.sender_id } : null;
  dto.unreadMessages = one("SELECT count(*) AS total FROM messages WHERE ticket_id=? AND receiver_id=? AND status!='READ'", ticket.id, ticket.student_id)?.total || 0;
  return dto;
}
