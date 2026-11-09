import { describe, expect, it } from 'vitest';
import { bindingBelongsTo } from './discovery';

function binding(name: string, subjects?: unknown[], labels: Record<string, string> = {}) {
  return { metadata: { name, labels }, subjects };
}

const sa = (name: string, namespace: string) => ({ kind: 'ServiceAccount', name, namespace });

describe('bindingBelongsTo', () => {
  it('matches on the subject', () => {
    expect(bindingBelongsTo(binding('anything', [sa('dev', 'a')]), 'dev', 'a')).toBe(true);
  });

  it('does not claim a same-named account from another namespace', () => {
    // Both accounts are called "dev" and the label and name match both — only the subject
    // tells them apart, and it says this binding is the one in namespace b.
    const other = binding('dev-binding-x', [sa('dev', 'b')], { 'access-builder/account': 'dev' });
    expect(bindingBelongsTo(other, 'dev', 'a')).toBe(false);
    expect(bindingBelongsTo(other, 'dev', 'b')).toBe(true);
  });

  it('falls back to the label when the subjects were edited away', () => {
    const b = binding('renamed', [], { 'access-builder/account': 'dev' });
    expect(bindingBelongsTo(b, 'dev', 'a')).toBe(true);
  });

  it('falls back to the naming convention', () => {
    expect(bindingBelongsTo(binding('dev-binding'), 'dev', 'a')).toBe(true);
    expect(bindingBelongsTo(binding('dev-binding-team'), 'dev', 'a')).toBe(true);
    expect(bindingBelongsTo(binding('dev-bindings'), 'dev', 'a')).toBe(false);
  });

  it('ignores a subject that only shares the name but is not a ServiceAccount', () => {
    const b = binding('x', [{ kind: 'User', name: 'dev' }]);
    expect(bindingBelongsTo(b, 'dev', 'a')).toBe(false);
  });
});
