import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import WebSocket from 'ws';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = ':memory:';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-lynk';
process.env.CLIENT_URL = 'http://127.0.0.1';
process.env.ACK_TIMEOUT_MS = '250';
process.env.MAX_RETRIES = '2';
const [{ createApp }, { attachWebSocketServer }, { db, run, now, one }, { config }] = await Promise.all([
  import('../server/app.js'), import('../server/realtime.js'), import('../server/db.js'), import('../server/config.js')
]);

const server = http.createServer(createApp());
const wss = attachWebSocketServer(server);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function cookieFrom(response) { return response.headers.get('set-cookie')?.split(';')[0]; }
async function api(path, { cookie, method = 'GET', body } = {}) {
  const multipart = body instanceof FormData;
  const response = await fetch(`${base}/api${path}`, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: multipart ? body : JSON.stringify(body) } : {})
  });
  return { response, data: await response.json().catch(() => ({})) };
}
async function register(name, email) {
  const { response, data } = await api('/auth/register', { method: 'POST', body: { name, email, password: 'strong-test-password-123' } });
  assert.equal(response.status, 201, JSON.stringify(data));
  return { cookie: cookieFrom(response), user: data.user };
}
async function login(email) {
  const { response, data } = await api('/auth/login', { method: 'POST', body: { email, password: 'strong-test-password-123' } });
  assert.equal(response.status, 200, JSON.stringify(data));
  return { cookie: cookieFrom(response), user: data.user };
}
function connect(cookie) {
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`, { headers: { Cookie: cookie } });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function waitFor(ws, type, predicate = () => true, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`Timed out waiting for ${type}`)); }, timeoutMs);
    function onMessage(data) {
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      if (event.type === type && predicate(event)) { clearTimeout(timer); ws.off('message', onMessage); resolve(event); }
      if (event.type === 'ERROR') { clearTimeout(timer); ws.off('message', onMessage); reject(new Error(event.message)); }
    }
    ws.on('message', onMessage);
  });
}
function post(ws, event) { ws.send(JSON.stringify(event)); }
function close(ws) { return new Promise(resolve => { if (!ws || ws.readyState === WebSocket.CLOSED) return resolve(); ws.once('close', resolve); ws.close(); }); }

test('LYNK authentication, authorization, ticket conversations, ACK lifecycle, retries and offline delivery', { timeout: 20000 }, async t => {
  t.after(async () => {
    await close(studentSocket);
    await close(adminSocket);
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  let studentSocket;
  let adminSocket;

  const unauthenticated = await api('/tickets');
  assert.equal(unauthenticated.response.status, 401);

  const student = await register('Sofia Bennett', 'sofia@example.test');
  const otherStudent = await register('Taylor Green', 'taylor@example.test');
  // Public registration creates students only. Create staff fixtures as the seed tool does.
  const helpdeskId = randomUUID();
  const adminId = randomUUID();
  const timestamp = now();
  run('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', adminId, 'Maya Chen', 'maya@example.test', await bcrypt.hash('strong-test-password-123', 12), 'ADMIN', timestamp, timestamp);
  run('INSERT INTO users(id,name,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', helpdeskId, 'Jordan Lee', 'jordan@example.test', await bcrypt.hash('strong-test-password-123', 12), 'HELPDESK', timestamp, timestamp);
  const admin = await login('maya@example.test');
  const helpdesk = await login('jordan@example.test');
  assert.equal(admin.user.role, 'ADMIN');
  const studentOnStaffPortal = await api('/auth/login', { method:'POST', body:{ email:'sofia@example.test', password:'strong-test-password-123', portal:'STAFF' } });
  assert.equal(studentOnStaffPortal.response.status, 403);
  const staffOnStudentPortal = await api('/auth/login', { method:'POST', body:{ email:'maya@example.test', password:'strong-test-password-123', portal:'STUDENT' } });
  assert.equal(staffOnStudentPortal.response.status, 403);
  const correctStudentPortal = await api('/auth/login', { method:'POST', body:{ email:'sofia@example.test', password:'strong-test-password-123', portal:'STUDENT' } });
  assert.equal(correctStudentPortal.response.status, 200);
  const deniedStaffCreation = await api('/admin/users', { cookie:student.cookie, method:'POST', body:{ name:'Unauthorized Staff', email:'unauthorized@example.test', role:'ADMIN', password:'long-test-password-123' } });
  assert.equal(deniedStaffCreation.response.status, 403);
  const createdStaff = await api('/admin/users', { cookie:admin.cookie, method:'POST', body:{ name:'New Helpdesk Agent', email:'new-agent@example.test', role:'HELPDESK', password:'long-test-password-123' } });
  assert.equal(createdStaff.response.status, 201);
  assert.equal(createdStaff.data.user.role, 'HELPDESK');
  assert.notEqual(one('SELECT password_hash FROM users WHERE id=?', createdStaff.data.user.id).password_hash, 'long-test-password-123');

  const created = await api('/tickets', { cookie: student.cookie, method: 'POST', body: { title: 'Library access', description: 'Evening access request', category: 'Library services', priority: 'HIGH' } });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const ticket = created.data.ticket;
  assert.equal(ticket.status, 'OPEN');
  assert.ok(ticket.conversationId);
  const conversation = await api(`/tickets/${ticket.id}/conversation`, { cookie: student.cookie });
  assert.equal(conversation.response.status, 200);
  assert.deepEqual(conversation.data.messages, []);
  const forbidden = await api(`/tickets/${ticket.id}`, { cookie: otherStudent.cookie });
  assert.equal(forbidden.response.status, 403);
  const forbiddenChat = await api(`/tickets/${ticket.id}/conversation`, { cookie: otherStudent.cookie });
  assert.equal(forbiddenChat.response.status, 403);
  const helpdeskQueueAccess = await api(`/tickets/${ticket.id}`, { cookie: helpdesk.cookie });
  assert.equal(helpdeskQueueAccess.response.status, 200);
  assert.equal(one('SELECT count(*) AS n FROM conversations WHERE ticket_id=?', ticket.id).n, 1);

  const assignment = await api(`/tickets/${ticket.id}`, { cookie: admin.cookie, method: 'PATCH', body: { assignedAdminId: adminId } });
  assert.equal(assignment.response.status, 200);
  assert.equal(assignment.data.ticket.status, 'ASSIGNED');
  const inProgress = await api(`/tickets/${ticket.id}`, { cookie: admin.cookie, method: 'PATCH', body: { status: 'IN_PROGRESS' } });
  assert.equal(inProgress.data.ticket.status, 'IN_PROGRESS');
  const deniedReassign = await api(`/tickets/${ticket.id}`, { cookie: helpdesk.cookie, method: 'PATCH', body: { assignedAdminId: adminId } });
  assert.equal(deniedReassign.response.status, 403);

  studentSocket = await connect(student.cookie);
  adminSocket = await connect(admin.cookie);
  const studentSync = waitFor(studentSocket, 'SYNC_RESPONSE');
  const adminSync = waitFor(adminSocket, 'SYNC_RESPONSE');
  post(studentSocket, { type: 'SUBSCRIBE', ticketId: ticket.id, conversationId: ticket.conversationId });
  post(adminSocket, { type: 'SUBSCRIBE', ticketId: ticket.id, conversationId: ticket.conversationId });
  await Promise.all([studentSync, adminSync]);

  const messageId = randomUUID();
  const accepted = waitFor(studentSocket, 'MESSAGE_ACCEPTED', event => event.message.messageId === messageId);
  const incoming = waitFor(adminSocket, 'MESSAGE', event => event.message.messageId === messageId);
  post(studentSocket, { type: 'MESSAGE', messageId, ticketId: ticket.id, conversationId: ticket.conversationId, senderId: student.user.id, content: 'Could you check access?' });
  const [acceptedEvent, incomingEvent] = await Promise.all([accepted, incoming]);
  assert.equal(acceptedEvent.message.status, 'SENT');
  assert.equal(incomingEvent.message.sequenceNumber, 1);
  const deliveredPromise = waitFor(studentSocket, 'MESSAGE_DELIVERED', event => event.messageId === messageId);
  post(adminSocket, { type: 'DELIVERY_ACK', messageId, ticketId: ticket.id, conversationId: ticket.conversationId });
  const delivered = await deliveredPromise;
  assert.ok(delivered.deliveredAt);
  const readPromise = waitFor(studentSocket, 'MESSAGE_READ', event => event.messageId === messageId);
  post(adminSocket, { type: 'READ_ACK', messageId, ticketId: ticket.id, conversationId: ticket.conversationId });
  const read = await readPromise;
  assert.ok(read.readAt);

  // Retransmitting the same client message ID is idempotent.
  const duplicateAck = waitFor(studentSocket, 'MESSAGE_ACCEPTED', event => event.message.messageId === messageId && event.duplicate);
  post(studentSocket, { type: 'MESSAGE', messageId, ticketId: ticket.id, conversationId: ticket.conversationId, content: 'Could you check access?' });
  await duplicateAck;
  assert.equal(one('SELECT count(*) AS n FROM messages WHERE client_message_id=?', messageId).n, 1);

  // The server retransmits unacknowledged messages and persists terminal failure.
  const failedMessageId = randomUUID();
  const failedIncoming = waitFor(adminSocket, 'MESSAGE', event => event.message.messageId === failedMessageId);
  const failedSender = waitFor(studentSocket, 'MESSAGE_FAILED', event => event.messageId === failedMessageId, 3000);
  post(studentSocket, { type:'MESSAGE', messageId:failedMessageId, ticketId:ticket.id, conversationId:ticket.conversationId, content:'Please confirm this is received.' });
  await Promise.all([failedIncoming, failedSender]);
  const failedRow = one('SELECT status,retry_count FROM messages WHERE client_message_id=?', failedMessageId);
  assert.equal(failedRow.status, 'FAILED');
  assert.equal(failedRow.retry_count, Number(process.env.MAX_RETRIES));

  // Attachments are server-validated, persisted, and SHA-256 checked.
  const attachmentEvent = waitFor(adminSocket, 'ATTACHMENT_MESSAGE', event => event.message.content.startsWith('Attachment:'));
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4\nLYNK attachment test\n%%EOF'], { type:'application/pdf' }), 'study-plan.pdf');
  const uploaded = await api(`/tickets/${ticket.id}/attachments`, { cookie:student.cookie, method:'POST', body:form });
  assert.equal(uploaded.response.status, 201, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.attachment.integrity, 'VERIFIED');
  const deliveredAttachment = await attachmentEvent;
  const attachmentMessageId = deliveredAttachment.message.messageId;
  const attachmentDelivered = waitFor(studentSocket, 'MESSAGE_DELIVERED', event => event.messageId === attachmentMessageId);
  post(adminSocket, { type:'DELIVERY_ACK', messageId:attachmentMessageId, ticketId:ticket.id, conversationId:ticket.conversationId });
  await attachmentDelivered;
  const verification = await api(`/attachments/${uploaded.data.attachment.id}/verify`, { cookie:student.cookie, method:'POST', body:{} });
  assert.equal(verification.response.status, 200);
  assert.equal(verification.data.integrity, 'VERIFIED');
  const download = await fetch(`${base}/api/attachments/${uploaded.data.attachment.id}`, { headers:{ Cookie:student.cookie } });
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('x-integrity-status'), 'VERIFIED');

  await close(adminSocket);
  adminSocket = null;
  const offlineIds = [randomUUID(), randomUUID()];
  for (const [index, id] of offlineIds.entries()) {
    const acceptedOffline = waitFor(studentSocket, 'MESSAGE_ACCEPTED', event => event.message.messageId === id);
    post(studentSocket, { type: 'MESSAGE', messageId: id, ticketId: ticket.id, conversationId: ticket.conversationId, content: `Offline follow-up ${index + 1}` });
    assert.equal((await acceptedOffline).message.status, 'QUEUED');
  }
  adminSocket = await connect(admin.cookie);
  const reconnectSync = waitFor(adminSocket, 'SYNC_RESPONSE');
  const queuedA = waitFor(adminSocket, 'MESSAGE', event => event.message.messageId === offlineIds[0]);
  const queuedB = waitFor(adminSocket, 'MESSAGE', event => event.message.messageId === offlineIds[1]);
  post(adminSocket, { type: 'SUBSCRIBE', ticketId: ticket.id, conversationId: ticket.conversationId });
  await reconnectSync;
  const [offlineA, offlineB] = await Promise.all([queuedA, queuedB]);
  assert.ok(offlineA.message.sequenceNumber < offlineB.message.sequenceNumber);
  const deliveryEvents = offlineIds.map(id => waitFor(studentSocket, 'MESSAGE_DELIVERED', event => event.messageId === id));
  for (const id of offlineIds) post(adminSocket, { type: 'DELIVERY_ACK', messageId: id, ticketId: ticket.id, conversationId: ticket.conversationId });
  await Promise.all(deliveryEvents);
  const readEvents = offlineIds.map(id => waitFor(studentSocket, 'MESSAGE_READ', event => event.messageId === id));
  for (const id of offlineIds) post(adminSocket, { type:'READ_ACK', messageId:id, ticketId:ticket.id, conversationId:ticket.conversationId });
  await Promise.all(readEvents);

  const secondTicketResponse = await api('/tickets', { cookie: student.cookie, method: 'POST', body: { title: 'Wi-Fi connection', description: 'Connection drops in the library.', category: 'IT Support' } });
  const secondTicket = secondTicketResponse.data.ticket;
  assert.equal(secondTicket.status, 'OPEN');
  assert.notEqual(secondTicket.conversationId, ticket.conversationId);
  const secondAssignment = await api(`/tickets/${secondTicket.id}`, { cookie:admin.cookie, method:'PATCH', body:{ assignedAdminId:adminId } });
  assert.equal(secondAssignment.data.ticket.status, 'ASSIGNED');
  const secondSync = waitFor(adminSocket, 'SYNC_RESPONSE', event => event.ticketId === secondTicket.id);
  post(adminSocket, { type:'SUBSCRIBE', ticketId:secondTicket.id, conversationId:secondTicket.conversationId });
  await secondSync;
  const secondMessageId = randomUUID();
  const secondAccepted = waitFor(studentSocket, 'MESSAGE_ACCEPTED', event => event.message.messageId === secondMessageId);
  const secondIncoming = waitFor(adminSocket, 'MESSAGE', event => event.message.messageId === secondMessageId);
  post(studentSocket, { type:'MESSAGE', messageId:secondMessageId, ticketId:secondTicket.id, conversationId:secondTicket.conversationId, content:'This belongs only to the Wi-Fi request.' });
  await Promise.all([secondAccepted, secondIncoming]);
  const firstHistory = await api(`/tickets/${ticket.id}/conversation`, { cookie:student.cookie });
  const secondHistory = await api(`/tickets/${secondTicket.id}/conversation`, { cookie:student.cookie });
  assert.equal(firstHistory.data.messages.some(message => message.messageId === secondMessageId), false);
  assert.deepEqual(secondHistory.data.messages.map(message => message.messageId), [secondMessageId]);

  const assignmentNotice = waitFor(studentSocket, 'NOTIFICATION', event => event.notification?.type === 'TICKET_ASSIGNED' && event.notification.ticketId === secondTicket.id);
  const reassigned = await api(`/tickets/${secondTicket.id}`, { cookie:admin.cookie, method:'PATCH', body:{ assignedAdminId:helpdeskId } });
  assert.equal(reassigned.response.status, 200);
  assert.equal(reassigned.data.ticket.assignedAdminId, helpdeskId);
  await assignmentNotice;
  const authorizedHelpdeskTicket = await api(`/tickets/${secondTicket.id}`, { cookie:helpdesk.cookie });
  assert.equal(authorizedHelpdeskTicket.response.status, 200);

  const resolvedNotification = waitFor(studentSocket, 'NOTIFICATION', event => event.notification?.type === 'TICKET_RESOLVED' && event.notification.ticketId === secondTicket.id);
  const resolvedTicket = await api(`/tickets/${secondTicket.id}`, { cookie: helpdesk.cookie, method: 'PATCH', body: { status: 'RESOLVED' } });
  assert.equal(resolvedTicket.response.status, 200);
  assert.equal(resolvedTicket.data.ticket.status, 'RESOLVED');
  assert.equal((await resolvedNotification).notification.title, 'Request resolved');
  const notifications = await api('/notifications', { cookie: student.cookie });
  assert.equal(notifications.response.status, 200);
  assert.ok(notifications.data.notifications.length >= 1);
  assert.ok(notifications.data.notifications.some(item => item.ticketId === secondTicket.id && item.type === 'TICKET_RESOLVED'));
  const firstNotificationId = notifications.data.notifications[0].id;
  const marked = await api(`/notifications/${firstNotificationId}/read`, { cookie:student.cookie, method:'PATCH', body:{} });
  assert.equal(marked.data.notification.isRead, true);
  const socketClosed = new Promise(resolve => studentSocket.once('close', resolve));
  const logout = await api('/auth/logout', { cookie:student.cookie, method:'POST' });
  assert.equal(logout.response.status, 200);
  await socketClosed;
  const revoked = await api('/auth/me', { cookie:student.cookie });
  assert.equal(revoked.response.status, 401);
});
