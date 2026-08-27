import { describe, expect, it } from 'vitest';
import {
  buildAll,
  buildBindings,
  BuildInput,
  buildUiClusterRead,
  deriveNames,
  levelFromUiAccessRules,
  PURPOSE_LABEL,
  PURPOSE_UI_CLUSTER_READ,
  roleKind,
  sanitizeName,
  UiAccessLevel,
  uiAccessRules,
  validateInput,
} from './rbac';

function input(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    scope: 'Namespaced',
    namespaces: ['default'],
    tokenNamespace: 'default',
    ...deriveNames('dev-user'),
    uiAccess: 'none',
    rules: [{ apiGroups: [''], resources: ['pods'], verbs: ['get'] }],
    ...overrides,
  };
}

describe('roleKind', () => {
  it('uses a plain Role for a single namespace', () => {
    expect(roleKind(input({ namespaces: ['default'] }))).toBe('Role');
  });

  it('switches to a ClusterRole once more than one namespace is bound', () => {
    expect(roleKind(input({ namespaces: ['a', 'b'] }))).toBe('ClusterRole');
  });

  it('always uses a ClusterRole for cluster scope', () => {
    expect(roleKind(input({ scope: 'Cluster', namespaces: [] }))).toBe('ClusterRole');
  });
});

describe('buildBindings', () => {
  it('creates one RoleBinding per namespace, all pointing at the same role', () => {
    const bindings = buildBindings(input({ namespaces: ['a', 'b', 'c'] }));
    expect(bindings).toHaveLength(3);
    expect(bindings.map(b => b.metadata.namespace)).toEqual(['a', 'b', 'c']);
    expect(bindings.map(b => b.metadata.name)).toEqual([
      'dev-user-binding-a',
      'dev-user-binding-b',
      'dev-user-binding-c',
    ]);
    expect(new Set(bindings.map(b => b.roleRef.name))).toEqual(new Set(['dev-user-role']));
    expect(new Set(bindings.map(b => b.roleRef.kind))).toEqual(new Set(['ClusterRole']));
  });

  it('creates a single ClusterRoleBinding for cluster scope', () => {
    const bindings = buildBindings(input({ scope: 'Cluster', namespaces: [] }));
    expect(bindings).toHaveLength(1);
    expect(bindings[0].kind).toBe('ClusterRoleBinding');
  });
});

describe('uiAccessRules', () => {
  it('grants nothing at level none', () => {
    expect(uiAccessRules('none')).toEqual([]);
  });

  it('grants only namespaces at the namespaces level', () => {
    const rules = uiAccessRules('namespaces');
    expect(rules).toHaveLength(1);
    expect(rules[0].resources).toEqual(['namespaces']);
  });

  it('adds nodes and metrics but not kubelet proxy at the metrics level', () => {
    const flat = uiAccessRules('metrics').flatMap(r => r.resources);
    expect(flat).toContain('nodes');
    expect(flat).not.toContain('nodes/proxy');
  });

  it('adds nodes/proxy only at the kubelet level', () => {
    expect(uiAccessRules('kubelet').flatMap(r => r.resources)).toContain('nodes/proxy');
  });

  it('round-trips through levelFromUiAccessRules', () => {
    const levels: UiAccessLevel[] = ['none', 'namespaces', 'metrics', 'kubelet'];
    for (const level of levels) {
      expect(levelFromUiAccessRules(uiAccessRules(level))).toBe(level);
    }
  });
});

describe('buildUiClusterRead', () => {
  it('builds nothing at level none', () => {
    expect(buildUiClusterRead(input({ uiAccess: 'none' }))).toEqual([]);
  });

  it('marks both objects so discovery can tell them apart from the account bindings', () => {
    const objs = buildUiClusterRead(input({ uiAccess: 'namespaces' }));
    expect(objs.map(o => o.kind)).toEqual(['ClusterRole', 'ClusterRoleBinding']);
    for (const o of objs) {
      expect(o.metadata.labels[PURPOSE_LABEL]).toBe(PURPOSE_UI_CLUSTER_READ);
      // The account label would make discovery treat this as the account's own binding.
      expect(o.metadata.labels['access-builder/account']).toBeUndefined();
      expect(o.metadata.name).toBe('dev-user-cluster-read');
    }
  });
});

describe('buildAll', () => {
  it('emits the cluster-read bundle alongside the account when asked', () => {
    const kinds = buildAll(input({ namespaces: ['a', 'b'], uiAccess: 'metrics' })).map(r => r.kind);
    expect(kinds).toEqual([
      'ServiceAccount',
      'Secret',
      'ClusterRole',
      'RoleBinding',
      'RoleBinding',
      'ClusterRole',
      'ClusterRoleBinding',
    ]);
  });
});

describe('sanitizeName', () => {
  it('lowercases and collapses invalid characters', () => {
    expect(sanitizeName('Dev User_01!')).toBe('dev-user-01');
  });

  it('falls back to a usable name when nothing survives', () => {
    expect(sanitizeName('!!!')).toBe('access');
  });

  it('leaves room for the longest generated suffix', () => {
    const derived = deriveNames('x'.repeat(300));
    expect(derived.clusterReadName.length).toBeLessThanOrEqual(253);
  });

  it('never ends in a dash after truncation', () => {
    expect(sanitizeName(`${'a'.repeat(239)}-bbbb`)).not.toMatch(/-$/);
  });
});

describe('validateInput', () => {
  it('accepts a well-formed input', () => {
    expect(validateInput(input())).toEqual([]);
  });

  it('rejects a namespaced account with no namespace', () => {
    expect(validateInput(input({ namespaces: [] }))).toContain('Pick at least one namespace.');
  });

  it('rejects a rule with no verbs', () => {
    const errors = validateInput(
      input({ rules: [{ apiGroups: [''], resources: ['pods'], verbs: [] }] }),
    );
    expect(errors).toContain('Rule 1: pick at least one verb.');
  });
});
