import { ControlError, listDevices, revokeDevice } from './client.js';
import { deleteLink, getLink } from './linkStore.js';
import { cancelSignIn } from './signin.js';

// Signing out forgets the token on this machine first and unconditionally,
// then asks the control plane to revoke this device, so the token stops
// working everywhere. The control plane has no "revoke me" call; this device
// is the one GET /v1/devices marks `current`, removed with DELETE
// /v1/devices/:id. Offline, the local sign-out still happens and the device
// stays listed on the account until it is removed from another device.
export async function signOut(ownerId, { fetchImpl, base } = {}) {
  cancelSignIn(ownerId);
  const link = await getLink(ownerId);
  if (!link) return { signedOut: false, revoked: false };
  await deleteLink(ownerId);
  if (!link.token) return { signedOut: true, revoked: false };

  const options = { ...(fetchImpl ? { fetchImpl } : {}), ...(base ? { base } : {}) };
  try {
    const { devices = [] } = (await listDevices(link.token, options)) ?? {};
    const current = devices.find((device) => device.current === true);
    if (!current) return { signedOut: true, revoked: false };
    await revokeDevice(link.token, current.id, options);
    return { signedOut: true, revoked: true };
  } catch (err) {
    if (!(err instanceof ControlError)) throw err;
    // Already revoked elsewhere counts as revoked.
    return { signedOut: true, revoked: err.status === 401 };
  }
}
