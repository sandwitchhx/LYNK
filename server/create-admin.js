import { createAdminIfMissing } from './admin-bootstrap.js';

const result = await createAdminIfMissing({
  name: process.env.LYNK_BOOTSTRAP_ADMIN_NAME,
  email: process.env.LYNK_BOOTSTRAP_ADMIN_EMAIL,
  password: process.env.LYNK_BOOTSTRAP_ADMIN_PASSWORD
});
console.log(result === 'CREATED' ? 'Created admin account.' : 'Admin account already exists; no changes were made.');
