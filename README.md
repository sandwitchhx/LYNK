# LYNK Campus Helpdesk

LYNK is a campus ticketing and live-chat application with separate student, administrator, and helpdesk access. The current front end is preserved as vanilla HTML/CSS/JavaScript; Express serves that app and the REST API from the same origin. SQLite is the authoritative source for accounts, tickets, ticket-specific conversations, messages, history, attachments, acknowledgements, and notifications.

## Run locally

Requirements: Node.js 24 or later (the application uses Node's built-in SQLite API), npm, and a modern browser.

```powershell
npm install
Copy-Item .env.example .env
# Set JWT_SECRET in .env to a unique secret of at least 32 characters.
npm run seed
npm start
```

Open `http://localhost:5002`. Student registration is available from the sign-in screen. Seeded staff accounts are development-only:

| Role | Default email | Default password |
|---|---|---|
| Student | `student@lynk.local` | `LYNK-student-demo-123!` |
| Admin | `admin@lynk.local` | `LYNK-admin-demo-123!` |
| Helpdesk | `helpdesk@lynk.local` | `LYNK-helpdesk-demo-123!` |

Public registration creates student accounts only. To add staff, sign in with an administrator account, open **Team accounts**, and create an Admin or Helpdesk account there. Admin access is never granted from an untrusted public signup form.

Override seed credentials with `SEED_STUDENT_EMAIL`, `SEED_STUDENT_PASSWORD`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_HELPDESK_EMAIL`, and `SEED_HELPDESK_PASSWORD`. Seed does not create tickets or messages. Do not use the default credentials in a deployed environment.

## Configuration

Copy `.env.example` to `.env`. The service listens on port **5002** by default. Configure `JWT_SECRET`, `CLIENT_URL`, `DATABASE_URL`, `UPLOAD_DIR`, `MAX_FILE_SIZE`, `ACK_TIMEOUT_MS`, `MAX_RETRIES`, `HEARTBEAT_INTERVAL_MS`, and `COOKIE_SECURE` through environment variables. Production requires a strong JWT secret and HTTPS (`COOKIE_SECURE=true`). Keep the upload directory outside any public static directory.

## Roles and authorization

- `STUDENT` can register, access their own tickets and conversations, and update their own preferences.
- `ADMIN` can review and assign tickets across the support queue.
- `HELPDESK` can work unassigned tickets and tickets assigned to that account; it cannot read another helpdesk user's assigned conversation.
- Staff registration is disabled. Add staff through a controlled seed/admin workflow.
- Authentication uses bcrypt password hashes and revocable JWT sessions in HTTP-only, SameSite cookies. The browser portal label is derived from the authenticated role. Changing browser state cannot grant role access.

## Ticket and chat model

Every ticket is created in `OPEN` state and has exactly one conversation, enforced by a unique database constraint on `conversations.ticket_id`. Message sequence numbers are unique and ordered per conversation. Student ownership and staff assignment checks are performed in the server before ticket, message, and attachment access.

The HTTP API handles account, ticket, preference, notification, and attachment operations. Native WebSockets (`ws`) handle real-time chat, presence, typing, delivery/read acknowledgements, and synchronization. A recipient's `DELIVERY_ACK` is required before a message is marked `DELIVERED`; `READ_ACK` is required before it is `READ`. Offline recipient messages remain queued in SQLite and are emitted in conversation sequence order after reconnect/subscription. Duplicate client message IDs are idempotent.

The full protocol, event envelopes, state diagrams, routes, and current deployment constraints are in [docs/architecture.md](docs/architecture.md).

## Tests

```powershell
npm test
```

The integration test runs an in-memory SQLite database and ephemeral HTTP/WebSocket server. It covers login/session revocation, student ownership checks, assignment and status transitions, per-ticket conversation isolation, live messaging, delivery/read ACKs, retries/failure, duplicate message IDs, offline delivery ordering, attachment upload/download, and SHA-256 verification. Node 24 currently marks its built-in `node:sqlite` API experimental.

## WebSocket load exercise

Start the app and seed development accounts, then configure the load script and run:

```powershell
$env:ADMIN_EMAIL='admin@lynk.local'
$env:ADMIN_PASSWORD='LYNK-admin-demo-123!'
$env:NUMBER_OF_CLIENTS='10'
$env:NUMBER_OF_TICKETS='20'
$env:MESSAGES_PER_CLIENT='5'
$env:MESSAGE_INTERVAL='25'
npm run load
```

The script reports the observations it collects (connections, messages, ACKs, retries, failures, latency, throughput, and reconnect results). These are not performance guarantees; measure on the target deployment before making capacity claims.
