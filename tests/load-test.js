import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

const baseUrl = (process.env.BASE_URL || 'http://localhost:5002').replace(/\/$/, '');
const numberOfClients = Number(process.env.NUMBER_OF_CLIENTS || 10);
const numberOfTickets = Number(process.env.NUMBER_OF_TICKETS || 20);
const messagesPerClient = Number(process.env.MESSAGES_PER_CLIENT || 5);
const messageInterval = Number(process.env.MESSAGE_INTERVAL || 25);
const adminEmail = process.env.ADMIN_EMAIL;
const adminPassword = process.env.ADMIN_PASSWORD;
if (!adminEmail || !adminPassword) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD for the seeded development admin.');
for (const [name,value] of Object.entries({ NUMBER_OF_CLIENTS:numberOfClients, NUMBER_OF_TICKETS:numberOfTickets, MESSAGES_PER_CLIENT:messagesPerClient, MESSAGE_INTERVAL:messageInterval })) {
  if (!Number.isInteger(value) || value < (name === 'MESSAGE_INTERVAL' ? 0 : 1)) throw new Error(`${name} must be a valid positive integer.`);
}

const metrics = { successfulConnections:0, failedConnections:0, peakConcurrentSessions:0, messagesSent:0, messagesReceived:0, deliveryAcks:0, readAcks:0, retries:0, failedMessages:0, reconnections:0, errors:0, latencyMs:[] };
const startedAt = Date.now();
const latencies = new Map();
const students = [];
const tickets = [];
const activeSockets = new Set();
let adminSocket;
let stopping = false;

async function api(path, { cookie, method='GET', body } = {}) {
  const response = await fetch(`${baseUrl}/api${path}`, { method, headers:{ ...(cookie ? { Cookie:cookie } : {}), ...(body ? { 'Content-Type':'application/json' } : {}) }, ...(body ? { body:JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${data.error?.message || 'request failed'}`);
  return { data, cookie:response.headers.get('set-cookie')?.split(';')[0] };
}
async function registerStudent(index) {
  const suffix = `${Date.now()}-${index}-${randomUUID().slice(0,8)}`;
  const result = await api('/auth/register', { method:'POST', body:{ name:`Load Student ${index + 1}`, email:`load-${suffix}@lynk.local`, password:`load-test-${randomUUID()}-safe` } });
  return { user:result.data.user, cookie:result.cookie, index, socket:null, ticketIds:[] };
}
async function signInAdmin() {
  const result = await api('/auth/login', { method:'POST', body:{ email:adminEmail, password:adminPassword } });
  return { user:result.data.user, cookie:result.cookie };
}
function connect(cookie, userId, onPacket) {
  const protocol = baseUrl.startsWith('https:') ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${new URL(baseUrl).host}/ws`, { headers:{ Cookie:cookie } });
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { metrics.failedConnections += 1; socket.terminate(); reject(new Error('WebSocket connection timed out.')); }, 10000);
    socket.once('open', () => { clearTimeout(timer); metrics.successfulConnections += 1; socket.userId = userId; activeSockets.add(socket); metrics.peakConcurrentSessions = Math.max(metrics.peakConcurrentSessions, activeSockets.size); socket.once('close', () => activeSockets.delete(socket)); resolve(socket); });
    socket.once('error', error => { clearTimeout(timer); metrics.failedConnections += 1; reject(error); });
    socket.on('message', data => {
      let packet;
      try { packet = JSON.parse(data.toString()); } catch { metrics.errors += 1; return; }
      if (packet.type === 'ERROR') metrics.errors += 1;
      onPacket?.(packet, socket);
    });
  });
}
function send(socket, packet) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(packet));
  return true;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function sendMessage(user, ticket, text) {
  const messageId = randomUUID();
  latencies.set(messageId, performance.now());
  if (send(user.socket, { type:'MESSAGE', messageId, ticketId:ticket.id, conversationId:ticket.conversationId, senderId:user.user.id, receiverId:ticket.assignedAdminId, content:text })) metrics.messagesSent += 1;
}

try {
  const admin = await signInAdmin();
  students.push(...await Promise.all(Array.from({ length:numberOfClients }, (_,index) => registerStudent(index))));
  const ticketCount = numberOfTickets;
  for (let index=0; index<ticketCount; index += 1) {
    const student = students[index % students.length];
    const { data } = await api('/tickets', { cookie:student.cookie, method:'POST', body:{ title:`Load exercise ticket ${index + 1}`, description:'Created by configurable local load tooling.', category:'Load test', priority:'NORMAL' } });
    const assigned = await api(`/tickets/${data.ticket.id}`, { cookie:admin.cookie, method:'PATCH', body:{ assignedAdminId:admin.user.id } });
    const ticket = assigned.data.ticket;
    student.ticketIds.push(ticket.id);
    tickets.push({ ...ticket, student });
  }

  adminSocket = await connect(admin.cookie, admin.user.id, packet => {
    if (packet.type === 'MESSAGE' || packet.type === 'MESSAGE_RETRY') {
      const message = packet.message;
      metrics.messagesReceived += 1;
      metrics.retries += packet.type === 'MESSAGE_RETRY' ? 1 : 0;
      send(adminSocket, { type:'DELIVERY_ACK', messageId:message.messageId, ticketId:message.ticketId, conversationId:message.conversationId });
      metrics.deliveryAcks += 1;
      send(adminSocket, { type:'READ_ACK', messageId:message.messageId, ticketId:message.ticketId, conversationId:message.conversationId });
      metrics.readAcks += 1;
      const user = students.find(candidate => candidate.user.id === message.senderId);
      const ticket = tickets.find(candidate => candidate.id === message.ticketId);
      if (user && ticket && !stopping) {
        const messageId = randomUUID();
        latencies.set(messageId, performance.now());
        if (send(adminSocket, { type:'MESSAGE', messageId, ticketId:ticket.id, conversationId:ticket.conversationId, senderId:admin.user.id, receiverId:user.user.id, content:'Load reply from the support team.' })) metrics.messagesSent += 1;
      }
    } else if (packet.type === 'MESSAGE_DELIVERED' || packet.type === 'MESSAGE_READ') {
      const began = latencies.get(packet.messageId);
      if (began !== undefined) { metrics.latencyMs.push(performance.now() - began); latencies.delete(packet.messageId); }
    } else if (packet.type === 'MESSAGE_FAILED') metrics.failedMessages += 1;
  });
  for (const ticket of tickets) send(adminSocket, { type:'SUBSCRIBE', ticketId:ticket.id, conversationId:ticket.conversationId });
  await Promise.all(students.map(async student => {
    student.socket = await connect(student.cookie, student.user.id, packet => {
      if (packet.type === 'MESSAGE' || packet.type === 'MESSAGE_RETRY') {
        const message = packet.message;
        metrics.messagesReceived += 1;
        metrics.retries += packet.type === 'MESSAGE_RETRY' ? 1 : 0;
        send(student.socket, { type:'DELIVERY_ACK', messageId:message.messageId, ticketId:message.ticketId, conversationId:message.conversationId });
        metrics.deliveryAcks += 1;
        send(student.socket, { type:'READ_ACK', messageId:message.messageId, ticketId:message.ticketId, conversationId:message.conversationId });
        metrics.readAcks += 1;
      } else if (packet.type === 'MESSAGE_DELIVERED' || packet.type === 'MESSAGE_READ') {
        const began = latencies.get(packet.messageId);
        if (began !== undefined) { metrics.latencyMs.push(performance.now() - began); latencies.delete(packet.messageId); }
      } else if (packet.type === 'MESSAGE_FAILED') metrics.failedMessages += 1;
    });
    for (const ticketId of student.ticketIds) {
      const ticket = tickets.find(item => item.id === ticketId);
      send(student.socket, { type:'SUBSCRIBE', ticketId:ticket.id, conversationId:ticket.conversationId });
    }
  }));

  const work = students.map(async student => {
    const ownTickets = tickets.filter(ticket => ticket.student === student);
    if (!ownTickets.length) return;
    for (let index=0; index<messagesPerClient; index += 1) {
      const ticket = ownTickets[index % ownTickets.length];
      sendMessage(student, ticket, `Load message ${index + 1} from client ${student.index + 1}.`);
      if (messageInterval) await sleep(messageInterval);
    }
  });
  await Promise.all(work);
  // Let the initial request/reply exchange finish before deliberately reconnecting clients.
  await sleep(Math.max(1000, Number(process.env.ACK_TIMEOUT_MS || 3000)));
  const reconnectionTargets = students.slice(0, Math.min(3, students.length));
  await Promise.all(reconnectionTargets.map(async student => {
    await new Promise(resolve => { if (!student.socket || student.socket.readyState === WebSocket.CLOSED) return resolve(); student.socket.once('close',resolve); student.socket.close(); });
    student.socket = await connect(student.cookie, student.user.id, packet => {
      if (packet.type === 'MESSAGE' || packet.type === 'MESSAGE_RETRY') {
        send(student.socket, { type:'DELIVERY_ACK', messageId:packet.message.messageId, ticketId:packet.message.ticketId, conversationId:packet.message.conversationId });
        send(student.socket, { type:'READ_ACK', messageId:packet.message.messageId, ticketId:packet.message.ticketId, conversationId:packet.message.conversationId });
      }
    });
    metrics.reconnections += 1;
    for (const ticketId of student.ticketIds) {
      const ticket = tickets.find(item => item.id === ticketId);
      send(student.socket, { type:'SUBSCRIBE', ticketId, conversationId:ticket.conversationId });
    }
  }));
  await sleep(Math.max(1000, Number(process.env.ACK_TIMEOUT_MS || 3000)));
  stopping = true;
} catch (error) {
  metrics.errors += 1;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await Promise.all([...students.map(student => student.socket),adminSocket].filter(Boolean).map(socket => new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.once('close',resolve); socket.close(); setTimeout(() => { socket.terminate(); resolve(); }, 1500).unref();
  })));
  const elapsedMs = Date.now() - startedAt;
  const sorted = [...metrics.latencyMs].sort((a,b) => a-b);
  console.log(JSON.stringify({ ...metrics, averageLatencyMs:sorted.length ? Number((sorted.reduce((a,b) => a+b,0)/sorted.length).toFixed(2)) : null, maxLatencyMs:sorted.length ? Number(sorted.at(-1).toFixed(2)) : null, successfulLatencySamples:sorted.length, elapsedMs, throughputMessagesPerSecond:Number((metrics.messagesReceived/(elapsedMs/1000)).toFixed(2)), configured:{numberOfClients,numberOfTickets,messagesPerClient,messageInterval} },null,2));
}
