import { describe, expect, it } from 'vitest';
import { isConflict, isNotFound, mergeOntoExisting } from './apply';

describe('mergeOntoExisting', () => {
  const live = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: 'app-config',
      namespace: 'prod',
      resourceVersion: '4711',
      uid: 'abc-123',
      labels: {
        'app.kubernetes.io/managed-by': 'Helm',
        'app.kubernetes.io/instance': 'my-release',
      },
      annotations: { 'meta.helm.sh/release-name': 'my-release' },
      ownerReferences: [{ kind: 'Deployment', name: 'owner' }],
    },
    data: { keep: 'a', drop: 'b' },
    binaryData: { 'cert.p12': 'AAAA' },
  };

  const desired = {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: 'app-config', namespace: 'prod' },
    data: { keep: 'changed' },
  };

  it('keeps labels the form never showed', () => {
    const merged = mergeOntoExisting(live, desired);
    expect(merged.metadata.labels).toEqual(live.metadata.labels);
  });

  it('keeps annotations, ownerReferences and uid', () => {
    const merged = mergeOntoExisting(live, desired);
    expect(merged.metadata.annotations['meta.helm.sh/release-name']).toBe('my-release');
    expect(merged.metadata.ownerReferences).toEqual(live.metadata.ownerReferences);
    expect(merged.metadata.uid).toBe('abc-123');
  });

  it('keeps fields the caller did not restate, such as binaryData', () => {
    expect(mergeOntoExisting(live, desired).binaryData).toEqual(live.binaryData);
  });

  it('replaces a restated key wholesale so removing an entry really removes it', () => {
    const merged = mergeOntoExisting(live, desired);
    expect(merged.data).toEqual({ keep: 'changed' });
    expect(merged.data.drop).toBeUndefined();
  });

  it('carries the live resourceVersion so the PUT is a proper optimistic update', () => {
    expect(mergeOntoExisting(live, desired).metadata.resourceVersion).toBe('4711');
  });

  it('lets the desired object win on keys both sides set', () => {
    const withLabels = {
      ...desired,
      metadata: { ...desired.metadata, labels: { 'app.kubernetes.io/instance': 'ours' } },
    };
    const merged = mergeOntoExisting(live, withLabels);
    expect(merged.metadata.labels['app.kubernetes.io/instance']).toBe('ours');
    // ...without dropping the ones only the live object had.
    expect(merged.metadata.labels['app.kubernetes.io/managed-by']).toBe('Helm');
  });

  it('does not resurrect data on a token Secret whose data the controller fills in', () => {
    const tokenSecret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'dev-user-token', namespace: 'default' },
      type: 'kubernetes.io/service-account-token',
      data: { token: 'generated', 'ca.crt': 'generated' },
    };
    const reapplied = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'dev-user-token', namespace: 'default' },
      type: 'kubernetes.io/service-account-token',
    };
    expect(mergeOntoExisting(tokenSecret, reapplied).data).toEqual(tokenSecret.data);
  });

  it('handles a live object with no metadata at all', () => {
    expect(() => mergeOntoExisting(undefined, desired)).not.toThrow();
    expect(mergeOntoExisting(undefined, desired).metadata.name).toBe('app-config');
  });
});

describe('isNotFound', () => {
  it('reads the status code when the error carries one', () => {
    expect(isNotFound({ status: 404 })).toBe(true);
    expect(isNotFound({ status: 403 })).toBe(false);
  });

  it('falls back to the message when there is no status', () => {
    expect(isNotFound(new Error('configmaps "x" not found'))).toBe(true);
  });

  it('is false for null and undefined', () => {
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
  });

  it('does not mistake an unrelated 403 for a 404', () => {
    expect(isNotFound(new Error('pods is forbidden: 403'))).toBe(false);
  });
});

describe('isConflict', () => {
  it('reads the status Headlamp puts on its errors', () => {
    expect(isConflict(Object.assign(new Error('x'), { status: 409 }))).toBe(true);
    expect(isConflict(Object.assign(new Error('x'), { status: 404 }))).toBe(false);
  });

  it('recognises a create that found the name taken', () => {
    expect(isConflict(new Error('configmaps "app" already exists'))).toBe(true);
  });

  it('recognises a stale resourceVersion on a patch', () => {
    expect(
      isConflict(
        new Error(
          'Operation cannot be fulfilled on ingresses.networking.k8s.io "web": the object has been modified; please apply your changes to the latest version and try again',
        ),
      ),
    ).toBe(true);
  });
});
