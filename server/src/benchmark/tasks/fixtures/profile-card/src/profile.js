// The one-line summary shown on a member's profile card. Members who signed
// up before addresses were collected have no address at all.

export function displayName(user) {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return name || user.email;
}

export function location(user) {
  const { city, country } = user.address;
  return [city, country].filter(Boolean).join(', ') || 'Location unknown';
}

export function profileLine(user) {
  return `${displayName(user)} · ${location(user)}`;
}
