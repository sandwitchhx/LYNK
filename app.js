const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const ui = { user: null, page: 'overview', tickets: [], visibleTickets: [], homeTickets: [], notifications: [], supportUsers: [], currentTicket: null, currentDetails: null, messages: new Map(), socket: null, reconnectTimer: null, reconnectAttempt: 0, unsent: new Map(), searchTimer: null, typingTimer: null, loadingAuth: false };
const toast = $('#toast');
let toastTimer;
let authPortal = 'STUDENT';
let authView = 'chooser';

function escapeHTML(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}
async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(path.startsWith('/api') ? path : `/api${path}`, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error?.message || `Request failed (${response.status}).`);
    error.status = response.status;
    error.code = data.error?.code;
    if (response.status === 401 && ui.user && !ui.loadingAuth) await expireSession();
    throw error;
  }
  return data;
}
function showAuth(message = '') {
  ui.loadingAuth = true;
  disconnectSocket();
  ui.user = null;
  $('.app-shell').classList.remove('authenticated');
  $('#auth-screen').hidden = false;
  $('#auth-feedback').textContent = message;
  ui.loadingAuth = false;
}
async function expireSession() { if (ui.user) showAuth('Your session has expired. Sign in again to continue.'); }
function setAuthView(view, portal = authPortal) {
  authView = view;
  authPortal = portal;
  const isStudent = portal === 'STUDENT';
  const isRegister = view === 'register';
  $('#auth-portal-choice').hidden = view !== 'chooser';
  $('#sign-in-form').hidden = view !== 'signin';
  $('#register-form').hidden = !isRegister;
  $('#auth-switch').hidden = view === 'chooser';
  $('#auth-back-button').hidden = view === 'chooser';
  $('#login-email-label').textContent = isStudent ? 'University email' : 'Staff email';
  $('#auth-title').textContent = view === 'chooser' ? 'Welcome to LYNK' : isRegister ? 'Create your student account' : isStudent ? 'Student sign in' : 'Admin & staff sign in';
  $('#auth-description').textContent = view === 'chooser' ? 'Choose the portal that matches your university role.' : isRegister ? 'Register with your university email to submit and track support requests.' : isStudent ? 'Sign in to submit requests and follow up with your support team.' : 'Sign in with the staff account provided by your university.';
  $('#auth-switch-prompt').textContent = isRegister ? 'Already registered?' : isStudent ? 'New student?' : 'Looking for a different portal?';
  $('#auth-switch-button').textContent = isRegister ? 'Sign in' : isStudent ? 'Create a student account' : 'Choose portal';
  $('#auth-feedback').textContent = '';
}
function statusLabel(status) { return ({ OPEN:'Open', ASSIGNED:'Assigned', IN_PROGRESS:'In progress', RESOLVED:'Resolved', CLOSED:'Closed' })[status] || status; }
function statusClass(status) { return ({ OPEN:'status-open', ASSIGNED:'status-open', IN_PROGRESS:'status-progress', RESOLVED:'status-resolved', CLOSED:'status-closed' })[status] || 'status-open'; }
function statusSymbol(status) { return status === 'RESOLVED' || status === 'CLOSED' ? '✓' : '●'; }
function shortDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric' }).format(date);
}
function timeLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat(undefined, { hour:'numeric', minute:'2-digit' }).format(date);
}
function topicIcon(category = '') {
  const value = category.toLowerCase();
  if (value.includes('technology') || value.includes('it')) return ['⌘','it'];
  if (value.includes('residence') || value.includes('housing')) return ['⌂','residence'];
  if (value.includes('library')) return ['▤','library'];
  if (value.includes('health')) return ['♡','residence'];
  return ['▤','library'];
}
function requestMarkup(ticket) {
  const [icon, kind] = topicIcon(ticket.category);
  const assignee = ticket.assignedAdminName || (ui.user.role === 'STUDENT' ? 'Awaiting assignment' : 'Unassigned');
  let action = '';
  if (ui.user.role === 'ADMIN' && ['OPEN','ASSIGNED','IN_PROGRESS'].includes(ticket.status)) {
    const options = ui.supportUsers.map(person => `<option value="${escapeHTML(person.id)}" ${person.id === ticket.assignedAdminId ? 'selected' : ''}>${escapeHTML(person.name)} · ${escapeHTML(person.role)}</option>`).join('');
    action += `<span class="queue-controls"><select class="row-assignee" data-assignee="${escapeHTML(ticket.id)}" aria-label="Assign ${escapeHTML(ticket.ticketId)}">${options}</select><button type="button" class="queue-action" data-queue-action="assign" data-request-id="${escapeHTML(ticket.id)}">${ticket.assignedAdminId ? 'Reassign' : 'Assign'}</button></span>`;
  } else if (ui.user.role === 'HELPDESK' && ticket.status === 'OPEN') {
      const options = ui.user.role === 'ADMIN' ? ui.supportUsers.map(person => `<option value="${escapeHTML(person.id)}" ${person.id === ticket.assignedAdminId ? 'selected' : ''}>${escapeHTML(person.name)} · ${escapeHTML(person.role)}</option>`).join('') : `<option value="${escapeHTML(ui.user.id)}">Assign to me</option>`;
      action = `<span class="queue-controls"><select class="row-assignee" data-assignee="${escapeHTML(ticket.id)}" aria-label="Assign ${escapeHTML(ticket.ticketId)}">${options}</select><button type="button" class="queue-action" data-queue-action="assign" data-request-id="${escapeHTML(ticket.id)}">Assign</button></span>`;
  }
  if (ui.user.role !== 'STUDENT') {
    if (['ASSIGNED','IN_PROGRESS'].includes(ticket.status)) action += `<button type="button" class="queue-action" data-queue-action="resolve" data-request-id="${escapeHTML(ticket.id)}">Resolve</button>`;
    else if (ticket.status === 'RESOLVED') action += `<button type="button" class="queue-action" data-queue-action="close" data-request-id="${escapeHTML(ticket.id)}">Close</button>`;
  }
  const conversationPeer = ui.user.role === 'STUDENT' ? assignee : (ticket.studentName || 'Student');
  return `<article class="request-row ${ui.user.role !== 'STUDENT' ? 'admin-request-row' : ''}" tabindex="0" data-request-id="${escapeHTML(ticket.id)}" aria-label="Open conversation for ${escapeHTML(ticket.title)} with ${escapeHTML(conversationPeer)}"><span class="request-icon icon-${kind}">${icon}</span><div class="request-detail"><strong>${escapeHTML(ticket.title)}</strong><span><b>${escapeHTML(ticket.ticketId)}</b> <i>·</i> ${escapeHTML(ticket.category)} <i>·</i> ${ui.user.role === 'STUDENT' ? escapeHTML(assignee) : escapeHTML(ticket.studentName || 'Student')} <i>·</i> ${shortDate(ticket.updatedAt)}</span></div><span class="priority-chip priority-${escapeHTML(ticket.priority.toLowerCase())}">${escapeHTML(ticket.priority)}</span><span class="status-pill ${statusClass(ticket.status)}">${statusSymbol(ticket.status)} ${statusLabel(ticket.status)}</span>${action}<span class="row-arrow">↗</span></article>`;
}
function renderTicketRows(tickets, target) {
  const list = $(target);
  if (!list) return;
  list.innerHTML = tickets.length ? tickets.map(requestMarkup).join('') : '<div class="empty-state"><span>✧</span>No requests found.</div>';
}
function renderTicketCategories() {
  const select = $('#category-filter');
  if (!select) return;
  const selected = select.value;
  const categories = [...new Set(ui.tickets.map(ticket => ticket.category).filter(Boolean))].sort();
  select.innerHTML = '<option value="">All categories</option>' + categories.map(category => `<option value="${escapeHTML(category)}">${escapeHTML(category)}</option>`).join('');
  select.value = categories.includes(selected) ? selected : '';
}
async function loadTickets() {
  if (!ui.user) return;
  const params = new URLSearchParams();
  const search = $('#ticket-search').value.trim();
  const status = $('.filter-tab.selected')?.dataset.filter;
  if (search) params.set('search', search);
  if (status) params.set('status', status);
  if ($('#priority-filter').value) params.set('priority', $('#priority-filter').value);
  if ($('#category-filter').value) params.set('category', $('#category-filter').value);
  const data = await request(`/tickets${params.size ? `?${params}` : ''}`);
  ui.visibleTickets = data.tickets;
  const allData = await request('/tickets');
  ui.tickets = allData.tickets;
  renderTicketCategories();
  renderTicketRows(ui.tickets.slice(0, 5), '#recent-requests');
  renderTicketRows(ui.visibleTickets, '#all-requests');
  renderTicketRows(ui.tickets.filter(ticket => ticket.status === 'OPEN' || ticket.status === 'ASSIGNED').slice(0, 5), '#admin-recent-requests');
  $('#filter-all').textContent = ui.tickets.length;
  renderConversationList();
}
function renderDashboard(data) {
  const counts = data.counts || {};
  for (const [id, key] of [['stat-open','OPEN'],['stat-assigned','ASSIGNED'],['stat-progress','IN_PROGRESS'],['stat-resolved','RESOLVED'],['stat-closed','CLOSED']]) $(`#${id}`).textContent = counts[key] || 0;
  $('#admin-open-count').textContent = counts.OPEN || 0;
  $('#admin-progress-count').textContent = counts.IN_PROGRESS || 0;
  $('#admin-resolved-count').textContent = counts.RESOLVED || 0;
  $('#admin-assigned-count').textContent = counts.ASSIGNED || 0;
  $('#admin-unresolved-count').textContent = (counts.OPEN || 0) + (counts.ASSIGNED || 0) + (counts.IN_PROGRESS || 0);
  $('#ticket-count').textContent = Object.values(counts).reduce((total,value) => total + value,0);
  $('#admin-unread-count').textContent = data.unreadMessages || 0;
  $('#student-greeting').innerHTML = `Welcome, ${escapeHTML(ui.user.name)} <span class="wave">☀</span>`;
  $('#admin-greeting').textContent = `Overview · ${ui.user.name}`;
  const message = data.recentMessage;
  $('#home-message-name').textContent = message ? `${message.senderName || 'Conversation'} · ${shortDate(message.createdAt)}` : 'No conversations yet';
  $('#home-message-text').textContent = message?.content || 'Messages for your support requests appear here.';
  $('#home-message-avatar').textContent = message ? (message.senderId === ui.user.id ? ui.user.name[0] : (message.senderName || 'S')[0]) : '·';
  $('#message-badge').textContent = data.unreadMessages || '';
  $('#message-badge').hidden = !data.unreadMessages;
  $('.nav-ping').hidden = !(data.unreadNotifications > 0);
}
async function loadDashboard() {
  if (!ui.user) return;
  const data = await request('/dashboard');
  renderDashboard(data);
  ui.homeTickets = data.tickets || [];
  renderTicketRows(ui.homeTickets.slice(0, 5), '#recent-requests');
  renderTicketRows(ui.homeTickets.filter(ticket => ticket.status === 'OPEN' || ticket.status === 'ASSIGNED').slice(0, 5), '#admin-recent-requests');
  renderConversationList();
}
async function loadSupportUsers() {
  if (ui.user?.role !== 'ADMIN') return;
  const data = await request('/admin/users');
  ui.supportUsers = data.users;
  $('#team-count').textContent = String(ui.supportUsers.length);
  $('#team-account-list').innerHTML = ui.supportUsers.length ? ui.supportUsers.map(user => `<article class="team-account-row"><span class="team-account-avatar">${escapeHTML((user.name || 'U').slice(0,1).toUpperCase())}</span><span class="team-account-details"><b>${escapeHTML(user.name)}</b><small>${escapeHTML(user.email)}</small></span><span class="team-role-pill ${user.role === 'ADMIN' ? 'admin' : ''}">${user.role === 'ADMIN' ? 'Admin' : 'Helpdesk'}</span></article>`).join('') : '<div class="empty-state">No staff accounts yet.</div>';
}
function pageView(page) { return page === 'overview' && ui.user?.role !== 'STUDENT' ? 'admin-overview' : page; }
async function setPage(page, { updateUrl = true } = {}) {
  if (!ui.user) return;
  ui.page = page;
  const viewName = pageView(page);
  const target = $(`[data-view="${viewName}"]`);
  if (!target) return;
  $$('.page').forEach(section => section.classList.toggle('active-page', section === target));
  $$('.nav-link[data-page]').forEach(button => button.classList.toggle('active', button.dataset.page === page));
  const currentLink = $(`.nav-link[data-page="${page}"] span:nth-child(2)`);
  $('#crumb-current').textContent = page === 'overview' ? (ui.user.role === 'STUDENT' ? 'Home' : 'Overview') : currentLink?.textContent || page;
  $('#sidebar').classList.remove('mobile-open');
  if (page === 'tickets') await loadTickets();
  if (page === 'overview') await loadDashboard();
  if (page === 'messages') {
    if (!ui.currentTicket && ui.tickets.length) await openTicket(ui.tickets[0].id, { updateUrl:false });
    renderConversationList();
  }
  if (page === 'notifications') await loadNotifications();
  if (page === 'settings') await loadSettings();
  if (page === 'team') await loadSupportUsers();
  if (updateUrl && location.pathname.startsWith('/tickets/')) history.pushState({}, '', '/');
  window.scrollTo({ top:0, behavior:'smooth' });
}
function setRoleUI() {
  const student = ui.user.role === 'STUDENT';
  $('#team-nav-link').hidden = ui.user.role !== 'ADMIN';
  $('.app-shell').classList.add('authenticated');
  $('#auth-screen').hidden = true;
  $('#account-role').textContent = student ? 'Student portal' : 'Admin portal';
  $('#account-name').textContent = ui.user.name;
  $('#sidebar-name').textContent = ui.user.name;
  $('#sidebar-role').textContent = ui.user.role === 'STUDENT' ? 'Student' : ui.user.role === 'ADMIN' ? 'Administrator' : 'Helpdesk';
  $('#sidebar-avatar').textContent = (ui.user.name || 'U').slice(0,1).toUpperCase();
  $('.campus-switch small').textContent = student ? 'Student portal' : 'Support workspace';
  $('.nav-link[data-page="overview"] span:nth-child(2)').textContent = student ? 'Home' : 'Overview';
  $('.nav-link[data-page="tickets"] span:nth-child(2)').textContent = student ? 'My requests' : 'Ticket queue';
  $('.nav-link[data-page="help"]').hidden = !student;
  $('.welcome-card').hidden = !student;
  $('#page-overview .section-title-row').hidden = !student;
  $('#page-overview .stats-grid').hidden = !student;
  $('#page-overview .home-grid').hidden = !student;
  $('#page-overview .gentle-note').hidden = !student;
  $$('[data-action="new-request"]').forEach(button => { button.hidden = !student; });
  $('.help-strip').hidden = !student;
  $('#tickets-heading').textContent = student ? 'My requests' : 'Ticket queue';
  $('#tickets-description').textContent = student ? 'Review status updates and follow up with your support team.' : 'Triage, assign, and update university support requests.';
  $('.filter-tabs').hidden = false;
  $('#priority-filter').hidden = student;
  $('#category-filter').hidden = student;
  const greeting = student ? `Welcome, ${ui.user.name}` : `Overview · ${ui.user.name}`;
  $('#student-greeting').innerHTML = `${escapeHTML(greeting)} <span class="wave">☀</span>`;
  $('#settings-name').textContent = ui.user.name;
  $('#settings-email').textContent = ui.user.email;
  $('#settings-avatar').textContent = (ui.user.name || 'U').slice(0,1).toUpperCase();
}
function formatError(error) {
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return 'LYNK could not reach its server. Start it with “npm start” from the project folder, then refresh this page.';
  return error?.message || 'Something went wrong. Please try again.';
}
async function enterApplication(user) {
  ui.user = user;
  setRoleUI();
  $('#auth-feedback').textContent = '';
  try {
    await Promise.all([loadTickets(), loadNotifications(), loadSupportUsers()]);
    connectSocket();
    setPage('overview', { updateUrl:false });
    const ticketFromUrl = decodeURIComponent(location.pathname.match(/^\/tickets\/([^/]+)$/)?.[1] || '');
    if (ticketFromUrl) await openTicket(ticketFromUrl, { updateUrl:false });
  } catch (error) {
    if (error.status === 401) showAuth('Please sign in to continue.');
    else showToast(formatError(error));
  }
}
async function signIn(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  $('#auth-feedback').textContent = '';
  try {
    const { user } = await request('/auth/login', { method:'POST', body:JSON.stringify({ email:$('#login-email').value, password:$('#login-password').value, portal:authPortal }) });
    await enterApplication(user);
  } catch (error) { $('#auth-feedback').textContent = formatError(error); }
  finally { submit.disabled = false; }
}
async function registerStudent(event) {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  $('#auth-feedback').textContent = '';
  try {
    const { user } = await request('/auth/register', { method:'POST', body:JSON.stringify({ name:$('#register-name').value, email:$('#register-email').value, password:$('#register-password').value }) });
    await enterApplication(user);
  } catch (error) { $('#auth-feedback').textContent = formatError(error); }
  finally { submit.disabled = false; }
}
async function createStaffAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  $('#team-create-feedback').textContent = '';
  try {
    await request('/admin/users', { method:'POST', body:JSON.stringify({ name:$('#team-name').value, email:$('#team-email').value, role:$('#team-role').value, password:$('#team-password').value }) });
    form.reset();
    $('#team-create-feedback').textContent = 'Staff account created. They can now sign in through the Admin & staff portal.';
    await loadSupportUsers();
  } catch (error) { $('#team-create-feedback').textContent = formatError(error); }
  finally { submit.disabled = false; }
}
async function signOut() {
  disconnectSocket();
  try { await request('/auth/logout', { method:'POST' }); } catch { /* Clear local app state even if the network is down. */ }
  ui.messages.clear(); ui.tickets = []; ui.currentTicket = null; ui.notifications = [];
  showAuth('You have signed out.');
  setAuthView('chooser');
}
function connectSocket() {
  if (!ui.user || ui.socket || !('WebSocket' in window)) return;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  ui.socket = socket;
  socket.addEventListener('open', () => {
    ui.reconnectAttempt = 0;
    $('.chat-header small').dataset.connection = 'ONLINE';
    socket.send(JSON.stringify({ type:'SYNC_REQUEST' }));
    if (ui.currentTicket) subscribeToTicket(ui.currentTicket);
    for (const message of ui.unsent.values()) transmitMessage(message);
  });
  socket.addEventListener('message', event => {
    let packet;
    try { packet = JSON.parse(event.data); } catch { return; }
    handleSocketEvent(packet);
  });
  socket.addEventListener('close', () => {
    if (ui.socket !== socket) return;
    ui.socket = null;
    if (ui.user) {
      updateConnectionState('DISCONNECTED');
      const wait = Math.min(1000 * (2 ** ui.reconnectAttempt), 15000);
      ui.reconnectAttempt += 1;
      ui.reconnectTimer = setTimeout(connectSocket, wait);
    }
  });
  socket.addEventListener('error', () => updateConnectionState('CONNECTING'));
}
function disconnectSocket() {
  clearTimeout(ui.reconnectTimer);
  ui.reconnectTimer = null;
  const socket = ui.socket;
  ui.socket = null;
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
}
function socketSend(packet) {
  if (ui.socket?.readyState !== WebSocket.OPEN) return false;
  ui.socket.send(JSON.stringify(packet));
  return true;
}
function updateConnectionState(state) {
  if (!ui.currentTicket) return;
  const label = $('#chat-peer-status');
  const online = state === 'ONLINE';
  label.innerHTML = `<i></i> ${online ? 'Connected' : state === 'CONNECTING' ? 'Connecting…' : 'Reconnecting…'}`;
  label.classList.toggle('is-online', online);
}
function subscribeToTicket(ticket) {
  if (!ticket?.conversationId) return;
  const existing = ui.messages.get(ticket.id) || [];
  const afterSequence = existing.reduce((max,message) => Math.max(max,message.sequenceNumber || 0),0);
  socketSend({ type:'SUBSCRIBE', ticketId:ticket.id, conversationId:ticket.conversationId, afterSequence });
}
function mergeMessage(message) {
  if (!message?.ticketId || !message.messageId) return;
  const current = ui.messages.get(message.ticketId) || [];
  const index = current.findIndex(item => item.messageId === message.messageId);
  if (index >= 0) current[index] = { ...current[index], ...message };
  else current.push(message);
  current.sort((a,b) => (a.sequenceNumber || Number.MAX_SAFE_INTEGER) - (b.sequenceNumber || Number.MAX_SAFE_INTEGER) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  ui.messages.set(message.ticketId, current);
  if (ui.currentTicket?.id === message.ticketId) renderMessages();
}
function updateMessage(messageId, patch) {
  for (const [ticketId, items] of ui.messages) {
    const item = items.find(message => message.messageId === messageId);
    if (!item) continue;
    Object.assign(item, patch);
    if (ui.currentTicket?.id === ticketId) renderMessages();
    return item;
  }
  return null;
}
function handleSocketEvent(packet) {
  switch (packet.type) {
    case 'CONNECTION_INIT': updateConnectionState('ONLINE'); break;
    case 'SYNC_RESPONSE':
      for (const message of packet.messages || []) {
        mergeMessage(message);
        acknowledgeReceivedMessage(message);
      }
      break;
    case 'MESSAGE':
    case 'MESSAGE_RETRY':
    case 'ATTACHMENT_MESSAGE': {
      const message = packet.message;
      if (!message) break;
      mergeMessage(message);
      acknowledgeReceivedMessage(message);
      break;
    }
    case 'MESSAGE_ACCEPTED':
      if (packet.message) {
        mergeMessage(packet.message);
        ui.unsent.delete(packet.message.messageId);
      }
      break;
    case 'MESSAGE_DELIVERED': updateMessage(packet.messageId, { status:'DELIVERED', deliveredAt:packet.deliveredAt }); break;
    case 'MESSAGE_READ': updateMessage(packet.messageId, { status:'READ', readAt:packet.readAt }); break;
    case 'MESSAGE_FAILED': updateMessage(packet.messageId, { status:'FAILED' }); showToast('A message could not be delivered. Retry from this conversation.'); break;
    case 'DELIVERY_ACK_ACCEPTED': updateMessage(packet.messageId, { status:'DELIVERED', deliveredAt:packet.deliveredAt }); break;
    case 'READ_ACK_ACCEPTED': updateMessage(packet.messageId, { status:'READ', readAt:packet.readAt }); break;
    case 'NOTIFICATION':
      if (packet.notification) {
        ui.notifications.unshift(packet.notification);
        renderNotifications();
        $('.nav-ping').hidden = false;
        if (packet.notification.type === 'NEW_MESSAGE') $('#message-badge').hidden = false;
        if (packet.notification.type === 'TICKET_RESOLVED') showToast(`${packet.notification.title}: ${packet.notification.message}`);
        loadDashboard().catch(() => {});
      }
      break;
    case 'PRESENCE_UPDATE':
      if (ui.currentTicket && packet.ticketId === ui.currentTicket.id) updateConnectionState(packet.state);
      break;
    case 'TYPING_START': if (ui.currentTicket?.id === packet.ticketId) $('#chat-peer-status').innerHTML = '<i></i> Typing…'; break;
    case 'TYPING_STOP': if (ui.currentTicket?.id === packet.ticketId) updateConnectionState('ONLINE'); break;
    case 'TICKET_CREATED':
    case 'TICKET_UPDATED':
    case 'TICKET_STATUS_CHANGED':
      if (packet.ticket && ui.currentTicket?.id === packet.ticket.id) {
        ui.currentTicket = { ...ui.currentTicket, ...packet.ticket };
        $('#chat-ticket-meta').textContent = `${ui.currentTicket.ticketId} · ${ui.currentTicket.category} · ${statusLabel(ui.currentTicket.status)} · ${ui.currentTicket.priority}`;
        renderMessages();
      }
      loadTickets().then(loadDashboard).catch(error => showToast(formatError(error)));
      break;
    case 'ERROR': showToast(packet.message || 'The live connection rejected an event.'); break;
  }
}
function acknowledgeReceivedMessage(message) {
  if (!ui.user || message.receiverId !== ui.user.id) return;
  socketSend({ type:'DELIVERY_ACK', messageId:message.messageId, ticketId:message.ticketId, conversationId:message.conversationId });
  const isOpen = ui.currentTicket?.id === message.ticketId && ui.page === 'messages' && !document.hidden;
  if (isOpen) socketSend({ type:'READ_ACK', messageId:message.messageId, ticketId:message.ticketId, conversationId:message.conversationId });
}
function renderConversationList() {
  const host = $('#conversation-list');
  if (!host) return;
  $('#conversation-count').textContent = ui.tickets.length;
  if (!ui.tickets.length) { host.innerHTML = '<div class="empty-state">No ticket conversations yet.</div>'; return; }
  host.innerHTML = ui.tickets.map(ticket => {
    const peer = ui.user.role === 'STUDENT' ? (ticket.assignedAdminName || 'Support team') : (ticket.studentName || 'Student');
    const last = ticket.lastMessage?.content || ticket.title;
    const initials = peer.slice(0,1).toUpperCase();
    return `<button class="conversation-item ${ui.currentTicket?.id === ticket.id ? 'selected' : ''}" data-open-ticket="${escapeHTML(ticket.id)}"><span class="maya-avatar large">${escapeHTML(initials)}<i></i></span><span class="conversation-meta"><b>${escapeHTML(peer)} <small>${shortDate(ticket.updatedAt)}</small></b><span>${escapeHTML(last)}</span><i>${escapeHTML(ticket.ticketId)} · ${escapeHTML(ticket.title)}</i></span></button>`;
  }).join('');
}
async function openTicket(ticketId, { updateUrl = true } = {}) {
  if (!ui.user) return;
  try {
    const [ticketData, conversationData] = await Promise.all([request(`/tickets/${encodeURIComponent(ticketId)}`), request(`/tickets/${encodeURIComponent(ticketId)}/conversation`)]);
    ui.currentDetails = ticketData;
    ui.currentTicket = ticketData.ticket;
    ui.messages.set(ui.currentTicket.id, conversationData.messages);
    const student = ui.user.role === 'STUDENT';
    const peerName = student ? (ui.currentTicket.assignedAdminName || 'Campus support') : (ui.currentTicket.studentName || 'Student');
    $('#chat-peer-name').textContent = peerName;
    $('#chat-peer-avatar').firstChild.textContent = peerName.slice(0,1).toUpperCase();
    $('#chat-peer-status').innerHTML = '<i></i> Checking connection…';
    $('#chat-ticket-title').textContent = ui.currentTicket.title;
    $('#chat-ticket-meta').textContent = `${ui.currentTicket.ticketId} · ${ui.currentTicket.category} · ${statusLabel(ui.currentTicket.status)} · ${ui.currentTicket.priority}`;
    $('#chat-view-ticket').hidden = false;
    $('#chat-input').disabled = false;
    $('#attach-button').disabled = false;
    $('.send-button').disabled = false;
    $('#chat-input').placeholder = student ? 'Message your support team...' : 'Reply to the student...';
    $('#chat-view-ticket').onclick = () => showTicketDetails(ui.currentTicket.id);
    renderMessages();
    renderConversationList();
    setPage('messages', { updateUrl:false });
    if (updateUrl) history.pushState({}, '', `/tickets/${encodeURIComponent(ui.currentTicket.ticketId)}`);
    subscribeToTicket(ui.currentTicket);
    // A message becomes READ only while its conversation is visible to its recipient.
    for (const message of conversationData.messages) {
      if (message.receiverId === ui.user.id && ['SENT','QUEUED','DELIVERED'].includes(message.status)) {
        socketSend({ type:'DELIVERY_ACK', messageId:message.messageId, ticketId:message.ticketId, conversationId:message.conversationId });
        socketSend({ type:'READ_ACK', messageId:message.messageId, ticketId:message.ticketId, conversationId:message.conversationId });
      }
    }
  } catch (error) { showToast(formatError(error)); }
}
async function showTicketDetails(ticketId) {
  try {
    const data = await request(`/tickets/${encodeURIComponent(ticketId)}`);
    ui.currentDetails = data;
    $('#detail-title').textContent = `${data.ticket.ticketId} · ${data.ticket.title}`;
    $('#detail-metadata').innerHTML = `<span>${escapeHTML(data.ticket.category)}</span><span>${escapeHTML(data.ticket.priority)}</span><span>${escapeHTML(statusLabel(data.ticket.status))}</span><span>${escapeHTML(data.ticket.assignedAdminName || 'Unassigned')}</span><span>Created ${shortDate(data.ticket.createdAt)}</span>`;
    $('#detail-description').textContent = data.ticket.description;
    $('#detail-history').innerHTML = data.history.length ? data.history.map(item => `<div class="detail-list-row"><b>${escapeHTML(item.type.replaceAll('_',' '))}</b><span>${escapeHTML(item.actorName || '')} · ${new Date(item.createdAt).toLocaleString()}</span></div>`).join('') : '<div class="detail-empty">No history recorded.</div>';
    $('#detail-attachments').innerHTML = data.attachments.length ? data.attachments.map(file => `<div class="detail-list-row"><a href="/api/attachments/${encodeURIComponent(file.id)}" target="_blank" rel="noopener">${escapeHTML(file.filename)}</a><span>${Math.ceil(file.size/1024)} KB · SHA-256 recorded</span></div>`).join('') : '<div class="detail-empty">No attachments.</div>';
    $('#detail-notifications').innerHTML = data.notifications.length ? data.notifications.map(item => `<div class="detail-list-row"><b>${escapeHTML(item.title)}</b><span>${escapeHTML(item.message)} · ${shortDate(item.createdAt)}</span></div>`).join('') : '<div class="detail-empty">No ticket notifications.</div>';
    $('#ticket-detail-modal').hidden = false;
  } catch (error) { showToast(formatError(error)); }
}
function messageStatus(message) {
  const labels = { PENDING:'Sending…', SENT:'Sent ✓', QUEUED:'Queued · offline', DELIVERED:'Delivered ✓✓', READ:'Read ✓✓', FAILED:'Failed · retry' };
  return labels[message.status] || '';
}
function renderMessage(message) {
  const mine = message.senderId === ui.user.id;
  const attachments = (message.attachments || []).map(file => {
    const fileName = escapeHTML(file.filename || file.originalFilename || 'Attachment');
    const link = `/api/attachments/${encodeURIComponent(file.id)}`;
    const preview = String(file.mimeType || '').startsWith('image/') ? `<a href="${link}" target="_blank" rel="noopener"><img class="chat-attachment-preview" src="${link}" alt="${fileName}"></a>` : '';
    return `<div class="chat-attachment">${preview}<a href="${link}" target="_blank" rel="noopener">${fileName} · ${Math.ceil((file.size || 0)/1024)} KB</a><button type="button" data-verify-attachment="${escapeHTML(file.id)}">Verify SHA-256</button></div>`;
  }).join('');
  return `<div class="chat-line ${mine ? 'mine' : ''}" data-message-id="${escapeHTML(message.messageId)}"><span class="mini-avatar">${mine ? escapeHTML(ui.user.name.slice(0,1).toUpperCase()) : escapeHTML((ui.user.role === 'STUDENT' ? ui.currentTicket?.assignedAdminName : ui.currentTicket?.studentName || 'S')?.slice(0,1).toUpperCase() || 'S')}</span><div class="bubble-wrap"><div class="bubble">${escapeHTML(message.content)}${attachments}</div><small class="bubble-meta">${timeLabel(message.createdAt)} · ${messageStatus(message)}</small></div></div>`;
}
function renderMessages() {
  const host = $('#chat-messages');
  if (!host) return;
  if (!ui.currentTicket) { host.innerHTML = '<div class="empty-state"><span>✧</span>Select a ticket to load its conversation.</div>'; return; }
  const messages = ui.messages.get(ui.currentTicket.id) || [];
  host.innerHTML = `<div class="chat-date">${escapeHTML(ui.currentTicket.ticketId)} · ${escapeHTML(statusLabel(ui.currentTicket.status))}</div>${messages.length ? messages.map(renderMessage).join('') : '<div class="empty-state">No messages in this ticket yet.</div>'}`;
  host.scrollTop = host.scrollHeight;
}
async function createTicket(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const { ticket } = await request('/tickets', { method:'POST', body:JSON.stringify({ title:$('#request-subject').value.trim(), description:$('#request-description').value.trim(), category:$('#request-topic').value, priority:$('#request-priority').value }) });
    form.reset(); closeRequestModal();
    await Promise.all([loadTickets(), loadDashboard()]);
    await openTicket(ticket.id);
    showToast(`Request ${ticket.ticketId} submitted.`);
  } catch (error) { showToast(formatError(error)); }
  finally { submit.disabled = false; }
}
function closeRequestModal() {
  $('#request-modal').hidden = true;
  document.body.style.overflow = '';
}
function transmitMessage(message) {
  if (!socketSend({ type:'MESSAGE', messageId:message.messageId, ticketId:message.ticketId, conversationId:message.conversationId, senderId:ui.user.id, receiverId:message.receiverId, content:message.content })) return false;
  return true;
}
function sendMessage(event) {
  event.preventDefault();
  const input = $('#chat-input');
  const content = input.value.trim();
  if (!content || !ui.currentTicket) return;
  const message = { messageId:crypto.randomUUID(), ticketId:ui.currentTicket.id, conversationId:ui.currentTicket.conversationId, senderId:ui.user.id, receiverId:ui.user.role === 'STUDENT' ? ui.currentTicket.assignedAdminId : ui.currentTicket.studentId, content, status:'PENDING', createdAt:new Date().toISOString() };
  mergeMessage(message);
  ui.unsent.set(message.messageId, message);
  transmitMessage(message);
  input.value = ''; input.style.height = 'auto';
}
async function uploadAttachment(file) {
  if (!file || !ui.currentTicket) return;
  const form = new FormData();
  form.append('file', file);
  const caption = prompt('Optional message with this file:') || '';
  form.append('caption', caption);
  try {
    const { message, attachment } = await request(`/tickets/${encodeURIComponent(ui.currentTicket.id)}/attachments`, { method:'POST', body:form });
    mergeMessage(message);
    showToast(`Attachment uploaded · SHA-256 ${attachment.integrity.toLowerCase()}.`);
  } catch (error) { showToast(formatError(error)); }
  finally { $('#attachment-input').value = ''; }
}
async function changeTicketStatus(id, action, assigneeId) {
  const body = action === 'assign' ? { assignedAdminId:assigneeId } : { status:{ resolve:'RESOLVED', close:'CLOSED' }[action] };
  try {
    const { ticket } = await request(`/tickets/${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify(body) });
    await Promise.all([loadTickets(), loadDashboard()]);
    if (ui.currentTicket?.id === ticket.id) {
      ui.currentTicket = ticket;
      $('#chat-ticket-meta').textContent = `${ticket.ticketId} · ${ticket.category} · ${statusLabel(ticket.status)} · ${ticket.priority}`;
    }
    showToast(`Ticket ${ticket.ticketId} updated: ${statusLabel(ticket.status)}.`);
  } catch (error) { showToast(formatError(error)); }
}
async function loadNotifications() {
  const data = await request('/notifications');
  ui.notifications = data.notifications;
  renderNotifications();
}
function renderNotifications() {
  const host = $('#notifications-list');
  if (!host) return;
  if (!ui.notifications.length) { host.innerHTML = '<div class="empty-state">No notifications yet.</div>'; $('#notification-foot').textContent = ''; return; }
  host.innerHTML = ui.notifications.map(item => `<article class="notification-row ${item.isRead ? '' : 'unread'}"><span class="notification-icon ${item.type.includes('MESSAGE') ? 'peach-icon' : item.type.includes('RESOLVED') ? 'mint-icon' : 'lilac-icon'}">${item.type.includes('MESSAGE') ? '▱' : item.type.includes('RESOLVED') ? '✓' : '✧'}</span><div><b>${escapeHTML(item.title)}</b><p>${escapeHTML(item.message)}</p><small>${new Date(item.createdAt).toLocaleString()}</small></div>${item.ticketId ? `<button data-notification-ticket="${escapeHTML(item.ticketId)}">Open ticket ↗</button>` : ''}${item.isRead ? '' : `<button data-mark-notification="${escapeHTML(item.id)}">Mark read</button>`}</article>`).join('');
  $('#notification-foot').textContent = '';
  $('.nav-ping').hidden = !ui.notifications.some(item => !item.isRead);
}
async function loadSettings() {
  const data = await request('/users/me/preferences');
  const preferences = data.preferences || {};
  $('#pref-request-updates').checked = preferences.requestUpdates !== false;
  $('#pref-new-messages').checked = preferences.newMessages !== false;
  $('#pref-reminders').checked = Boolean(preferences.reminders);
  const reducedMotion = preferences.reducedMotion ?? localStorage.getItem('lynk-reduced-motion') === 'true';
  $('#reduced-motion-toggle').checked = reducedMotion;
  document.documentElement.classList.toggle('reduce-motion', reducedMotion);
}
async function savePreferences() {
  try {
    const preferences = { requestUpdates:$('#pref-request-updates').checked, newMessages:$('#pref-new-messages').checked, reminders:$('#pref-reminders').checked };
    await request('/users/me/preferences', { method:'PATCH', body:JSON.stringify(preferences) });
    showToast('Notification preferences saved.');
  } catch (error) { showToast(formatError(error)); }
}
async function markNotification(id) {
  try {
    if (id) await request(`/notifications/${encodeURIComponent(id)}/read`, { method:'PATCH', body:'{}' });
    else await request('/notifications/read-all', { method:'PATCH', body:'{}' });
    await loadNotifications();
  } catch (error) { showToast(formatError(error)); }
}

$('#auth-switch-button').addEventListener('click', () => {
  if (authPortal === 'STAFF') setAuthView('chooser');
  else setAuthView(authView === 'register' ? 'signin' : 'register', 'STUDENT');
});
$('#auth-back-button').addEventListener('click', () => setAuthView('chooser'));
$$('[data-auth-portal]').forEach(button => button.addEventListener('click', () => setAuthView('signin', button.dataset.authPortal)));
$('#sign-in-form').addEventListener('submit', signIn);
$('#register-form').addEventListener('submit', registerStudent);
$('#team-create-form').addEventListener('submit', createStaffAccount);
$('#signout-button').addEventListener('click', signOut);
$$('.nav-link[data-page]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.page).catch(error => showToast(formatError(error)))));
$$('[data-page-jump]').forEach(button => button.addEventListener('click', () => setPage(button.dataset.pageJump).catch(error => showToast(formatError(error)))));
$$('[data-action="new-request"]').forEach(button => button.addEventListener('click', () => { $('#request-modal').hidden = false; document.body.style.overflow = 'hidden'; setTimeout(() => $('#request-topic').focus(), 40); }));
$('#mobile-menu').addEventListener('click', () => $('#sidebar').classList.toggle('mobile-open'));
$('.profile-button').addEventListener('click', () => setPage('settings'));
$('.modal-close').addEventListener('click', () => { $('#request-modal').hidden = true; document.body.style.overflow = ''; });
$('#request-modal').addEventListener('click', event => { if (event.target === $('#request-modal')) { $('#request-modal').hidden = true; document.body.style.overflow = ''; } });
$('#request-form').addEventListener('submit', createTicket);
$('#chat-form').addEventListener('submit', sendMessage);
$('#chat-input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); $('#chat-form').requestSubmit(); }
});
$('#chat-input').addEventListener('input', event => {
  event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 90)}px`;
  if (ui.currentTicket && socketSend({ type:'TYPING_START', conversationId:ui.currentTicket.conversationId })) {
    clearTimeout(ui.typingTimer);
    ui.typingTimer = setTimeout(() => socketSend({ type:'TYPING_STOP', conversationId:ui.currentTicket?.conversationId }), 900);
  }
});
$('#attach-button').addEventListener('click', () => $('#attachment-input').click());
$('#attachment-input').addEventListener('change', event => uploadAttachment(event.target.files[0]));
function handleTicketListClick(event) {
  const action = event.target.closest('[data-queue-action]');
  if (action) {
    event.preventDefault();
    event.stopPropagation();
    const row = action.closest('.request-row');
    const assigneeId = row?.querySelector('.row-assignee')?.value;
    changeTicketStatus(action.dataset.requestId, action.dataset.queueAction, assigneeId);
    return;
  }
  if (event.target.closest('.row-assignee')) return;
  const row = event.target.closest('.request-row');
  if (row) openTicket(row.dataset.requestId).catch(error => showToast(formatError(error)));
}
function handleTicketListKeydown(event) {
  if (!['Enter',' '].includes(event.key) || event.target.closest('button,select')) return;
  const row = event.target.closest('.request-row');
  if (!row) return;
  event.preventDefault();
  openTicket(row.dataset.requestId).catch(error => showToast(formatError(error)));
}
$$('#all-requests,#recent-requests,#admin-recent-requests').forEach(list => {
  list.addEventListener('click', handleTicketListClick);
  list.addEventListener('keydown', handleTicketListKeydown);
});
$('#conversation-list').addEventListener('click', event => {
  const button = event.target.closest('[data-open-ticket]');
  if (button) openTicket(button.dataset.openTicket).catch(error => showToast(formatError(error)));
});
$('#chat-messages').addEventListener('click', async event => {
  const button = event.target.closest('[data-verify-attachment]');
  if (!button) return;
  try {
    const data = await request(`/attachments/${encodeURIComponent(button.dataset.verifyAttachment)}/verify`, { method:'POST', body:'{}' });
    showToast(`SHA-256 integrity ${data.integrity.toLowerCase()}.`);
  } catch (error) { showToast(formatError(error)); }
});
$('#chat-view-ticket').addEventListener('click', () => { if (ui.currentTicket) showTicketDetails(ui.currentTicket.id); });
$('.detail-modal-close').addEventListener('click', () => { $('#ticket-detail-modal').hidden = true; });
$('#ticket-detail-modal').addEventListener('click', event => { if (event.target === $('#ticket-detail-modal')) $('#ticket-detail-modal').hidden = true; });
$('#detail-open-conversation').addEventListener('click', () => { $('#ticket-detail-modal').hidden = true; if (ui.currentDetails?.ticket) openTicket(ui.currentDetails.ticket.id); });
$('#ticket-search').addEventListener('input', () => { clearTimeout(ui.searchTimer); ui.searchTimer = setTimeout(() => loadTickets().catch(error => showToast(formatError(error))), 200); });
$('#priority-filter').addEventListener('change', () => loadTickets().catch(error => showToast(formatError(error))));
$('#category-filter').addEventListener('change', () => loadTickets().catch(error => showToast(formatError(error))));
$$('.filter-tab').forEach(button => button.addEventListener('click', () => {
  $$('.filter-tab').forEach(tab => tab.classList.toggle('selected', tab === button));
  loadTickets().catch(error => showToast(formatError(error)));
}));
$('#mark-read').addEventListener('click', () => markNotification(null));
$('#notifications-list').addEventListener('click', event => {
  const read = event.target.closest('[data-mark-notification]');
  const ticket = event.target.closest('[data-notification-ticket]');
  if (read) markNotification(read.dataset.markNotification);
  else if (ticket) openTicket(ticket.dataset.notificationTicket).catch(error => showToast(formatError(error)));
});
$('#edit-profile').addEventListener('click', async () => {
  const name = prompt('Update your display name:', ui.user.name);
  if (!name || !name.trim() || name.trim() === ui.user.name) return;
  try {
    const { user } = await request('/users/me', { method:'PATCH', body:JSON.stringify({ name:name.trim() }) });
    ui.user = user; setRoleUI(); showToast('Your profile has been updated.');
  } catch (error) { showToast(formatError(error)); }
});
['#pref-request-updates','#pref-new-messages','#pref-reminders'].forEach(selector => $(selector).addEventListener('change', savePreferences));
$('#reduced-motion-toggle').addEventListener('change', event => {
  document.documentElement.classList.toggle('reduce-motion', event.target.checked);
  localStorage.setItem('lynk-reduced-motion', String(event.target.checked));
});
$('#priority-filter').hidden = true;
$('#category-filter').hidden = true;
window.addEventListener('popstate', () => {
  const ticketId = decodeURIComponent(location.pathname.match(/^\/tickets\/([^/]+)$/)?.[1] || '');
  if (ticketId) openTicket(ticketId, { updateUrl:false });
  else setPage('overview', { updateUrl:false });
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !ui.currentTicket || ui.page !== 'messages') return;
  const messages = ui.messages.get(ui.currentTicket.id) || [];
  for (const message of messages) if (message.receiverId === ui.user?.id && ['SENT','DELIVERED'].includes(message.status)) socketSend({ type:'READ_ACK', messageId:message.messageId, ticketId:message.ticketId, conversationId:message.conversationId });
});
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#request-modal').hidden) { $('#request-modal').hidden = true; document.body.style.overflow = ''; } });

async function initialize() {
  const reducedMotion = localStorage.getItem('lynk-reduced-motion') === 'true';
  $('#reduced-motion-toggle').checked = reducedMotion;
  document.documentElement.classList.toggle('reduce-motion', reducedMotion);
  try {
    const { user } = await request('/auth/me');
    await enterApplication(user);
  } catch (error) {
    if (error.status === 401) showAuth();
    else showAuth('LYNK could not reach its server. Start it with “npm start” from the project folder, then refresh this page.');
  }
}
initialize();
