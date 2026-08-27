import { post, request } from '@kinvolk/headlamp-plugin/lib/ApiProxy';

/**
 * Short-lived credentials via the TokenRequest API, as an alternative to the long-lived
 * `kubernetes.io/service-account-token` Secret.
 *
 * The Secret-backed token never expires and cannot be revoked short of deleting the Secret
 * (and even then it stays valid until the SA itself goes). A TokenRequest token carries an
 * expiry the API server enforces. The trade-off is that it cannot be renewed from the
 * kubeconfig — when it runs out, someone has to issue a new one here.
 */

export type TokenLifetime = {
  label: string;
  seconds: number;
};

export const TOKEN_LIFETIMES: TokenLifetime[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '8 hours', seconds: 8 * 3600 },
  { label: '1 day', seconds: 24 * 3600 },
  { label: '7 days', seconds: 7 * 24 * 3600 },
  { label: '30 days', seconds: 30 * 24 * 3600 },
  { label: '90 days', seconds: 90 * 24 * 3600 },
  { label: '1 year', seconds: 365 * 24 * 3600 },
];

export type IssuedToken = {
  token: string;
  /** What the API server actually granted, which may be shorter than requested. */
  expirationTimestamp: string;
  requestedSeconds: number;
};

export async function requestToken(
  namespace: string,
  serviceAccountName: string,
  expirationSeconds: number,
): Promise<IssuedToken> {
  const url = `/api/v1/namespaces/${namespace}/serviceaccounts/${serviceAccountName}/token`;
  const body = {
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenRequest',
    spec: {
      // No audiences: the token is meant for the API server itself.
      expirationSeconds,
    },
  };
  const res: any = await post(url, body, false);
  const token = res?.status?.token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('TokenRequest returned no token.');
  }
  return {
    token,
    expirationTimestamp: res?.status?.expirationTimestamp ?? '',
    requestedSeconds: expirationSeconds,
  };
}

/**
 * The cluster CA, for a kubeconfig that has no token Secret to take it from.
 *
 * Every namespace has carried a `kube-root-ca.crt` ConfigMap since Kubernetes 1.20; the
 * cluster-info kubeconfig in kube-public is the fallback for older or trimmed clusters.
 */
export async function fetchClusterCaBase64(namespace: string): Promise<string | null> {
  try {
    const cm: any = await request(`/api/v1/namespaces/${namespace}/configmaps/kube-root-ca.crt`);
    const pem = cm?.data?.['ca.crt'];
    if (typeof pem === 'string' && pem.includes('BEGIN CERTIFICATE')) {
      return btoa(pem);
    }
  } catch {
    // fall through
  }
  try {
    const cm: any = await request('/api/v1/namespaces/kube-public/configmaps/cluster-info');
    const kc = cm?.data?.kubeconfig;
    if (typeof kc === 'string') {
      const m = kc.match(/certificate-authority-data:\s*([A-Za-z0-9+/=]+)/);
      if (m) return m[1];
    }
  } catch {
    // ignore
  }
  return null;
}

/** Human-readable "expires in ..." for an RFC3339 timestamp. */
export function formatExpiry(timestamp: string, now: number = Date.now()): string {
  if (!timestamp) return 'unknown';
  const at = new Date(timestamp).getTime();
  if (!Number.isFinite(at)) return 'unknown';
  const ms = at - now;
  if (ms <= 0) return 'expired';
  const hours = ms / 3600_000;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * The API server silently clamps a request to its own maximum
 * (`--service-account-max-token-expiration`), so a shorter grant is normal, not an error.
 */
export function wasClamped(issued: IssuedToken, now: number = Date.now()): boolean {
  if (!issued.expirationTimestamp) return false;
  const at = new Date(issued.expirationTimestamp).getTime();
  if (!Number.isFinite(at)) return false;
  const granted = (at - now) / 1000;
  // A minute of slack for the round-trip.
  return granted < issued.requestedSeconds - 60;
}
