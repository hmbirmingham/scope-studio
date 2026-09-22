import { getPool } from '../db/pool.js';

export async function createUser({ email, passwordHash }) {
  const { rows } = await getPool().query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, created_at`,
    [email, passwordHash]
  );
  return rows[0];
}

export async function findUserByEmail(email) {
  const { rows } = await getPool().query(
    'SELECT id, email, password_hash FROM users WHERE email = $1',
    [email]
  );
  return rows[0] ?? null;
}
