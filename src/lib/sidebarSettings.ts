const STORAGE_KEY = 'click-ops:sidebar-settings';
export const MORE_PARENT_NAME = 'click-ops-more';
export const MORE_LABEL = 'More';

export interface SidebarSettings {
  hidden: string[];
}

export function loadSettings(): SidebarSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { hidden: [] };
    const parsed = JSON.parse(raw);
    return {
      hidden: Array.isArray(parsed?.hidden)
        ? parsed.hidden.filter((x: unknown) => typeof x === 'string')
        : [],
    };
  } catch {
    return { hidden: [] };
  }
}

let cachedSettings: SidebarSettings = loadSettings();

export function saveSettings(s: SidebarSettings): void {
  cachedSettings = { hidden: [...s.hidden] };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cachedSettings));
}

export function getCurrentSettings(): SidebarSettings {
  return cachedSettings;
}

export interface DiscoveredEntry {
  name: string;
  label: string;
  icon?: unknown;
  parent: string | null;
  url?: string;
}

const discovered = new Map<string, DiscoveredEntry>();
const discoverySubs = new Set<() => void>();
let snapshot: DiscoveredEntry[] = [];
let snapshotVersion = 0;
let lastBuiltVersion = -1;

function rebuildSnapshotIfNeeded(): DiscoveredEntry[] {
  if (lastBuiltVersion !== snapshotVersion) {
    snapshot = [...discovered.values()];
    lastBuiltVersion = snapshotVersion;
  }
  return snapshot;
}

export function recordDiscovered(entry: DiscoveredEntry): void {
  if (!entry.name) return;
  const prev = discovered.get(entry.name);
  const merged: DiscoveredEntry = prev
    ? {
        name: entry.name,
        label: entry.label || prev.label,
        icon: entry.icon !== undefined ? entry.icon : prev.icon,
        parent: entry.parent !== null ? entry.parent : prev.parent,
        url: entry.url ?? prev.url,
      }
    : { name: entry.name, label: entry.label, icon: entry.icon, parent: entry.parent, url: entry.url };
  if (
    prev &&
    prev.label === merged.label &&
    prev.icon === merged.icon &&
    prev.parent === merged.parent &&
    prev.url === merged.url
  ) {
    return;
  }
  discovered.set(entry.name, merged);
  snapshotVersion += 1;
  discoverySubs.forEach(fn => {
    try { fn(); } catch { /* listener errors don't break the filter */ }
  });
}

export function getDiscoveredEntries(): DiscoveredEntry[] {
  return rebuildSnapshotIfNeeded();
}

export function subscribeDiscovered(fn: () => void): () => void {
  discoverySubs.add(fn);
  return () => { discoverySubs.delete(fn); };
}
