// In-memory placeholder — DATABASE_URL has not been provided yet, so user
// persistence can't be wired to Postgres until that credential arrives and
// the Sprint 2 node-schema migration lands. Swap this for a real repository
// backed by pg at that point; the function signatures are the contract.
const usersByEmail = new Map();

export function createUser({ email, passwordHash }) {
  if (usersByEmail.has(email)) {
    throw new Error('User already exists');
  }
  const user = { id: crypto.randomUUID(), email, passwordHash };
  usersByEmail.set(email, user);
  return user;
}

export function findUserByEmail(email) {
  return usersByEmail.get(email) || null;
}
