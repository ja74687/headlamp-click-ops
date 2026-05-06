import {
  registerRoute,
  registerSidebarEntry,
  registerSidebarEntryFilter,
} from '@kinvolk/headlamp-plugin/lib';
import AccessBuilderPage from './AccessBuilderPage';
import ClusterMonitorPage from './ClusterMonitorPage';
import ResourceBuilderPage from './ResourceBuilderPage';
import SidebarSettingsPage from './SidebarSettingsPage';
import { getCurrentSettings, recordDiscovered } from './lib/sidebarSettings';

// eslint-disable-next-line no-console
console.log('[access-builder] plugin loaded');

const PROTECTED_ENTRIES = new Set(['sidebar-settings']);

interface SidebarItemLike {
  name: string;
  label?: string;
  icon?: unknown;
  url?: string;
  parent?: string | null;
  subList?: SidebarItemLike[];
}

function recordRecursive(item: SidebarItemLike, parent: string | null): void {
  if (item.name && item.name !== 'sidebar-settings') {
    recordDiscovered({
      name: item.name,
      label: item.label ?? item.name,
      icon: item.icon,
      parent,
      url: item.url,
    });
  }
  if (Array.isArray(item.subList)) {
    for (const child of item.subList) {
      recordRecursive(child, item.name);
    }
  }
}

registerSidebarEntryFilter(entry => {
  const e = entry as SidebarItemLike;
  const rawParent = e.parent;
  const parentName =
    rawParent === null || rawParent === undefined || rawParent === ''
      ? null
      : rawParent;

  recordRecursive(e, parentName);

  if (PROTECTED_ENTRIES.has(e.name)) {
    return entry;
  }

  if (getCurrentSettings().hidden.includes(e.name)) {
    return null;
  }

  return entry;
});

registerSidebarEntry({
  parent: null,
  sidebar: 'IN-CLUSTER',
  name: 'access-builder',
  label: 'Access Builder',
  url: '/access-builder',
  icon: 'mdi:key-chain-variant',
  useClusterURL: true,
});

registerRoute({
  path: '/access-builder',
  sidebar: 'access-builder',
  name: 'access-builder',
  exact: true,
  useClusterURL: true,
  component: () => <AccessBuilderPage />,
});

registerSidebarEntry({
  parent: null,
  sidebar: 'IN-CLUSTER',
  name: 'resource-builder',
  label: 'Resource Builder',
  url: '/resource-builder',
  icon: 'mdi:file-plus-outline',
  useClusterURL: true,
});

registerRoute({
  path: '/resource-builder',
  sidebar: 'resource-builder',
  name: 'resource-builder',
  exact: true,
  useClusterURL: true,
  component: () => <ResourceBuilderPage />,
});

registerSidebarEntry({
  parent: null,
  sidebar: 'IN-CLUSTER',
  name: 'cluster-monitor',
  label: 'Cluster Monitor',
  url: '/cluster-monitor',
  icon: 'mdi:gauge',
  useClusterURL: true,
});

registerRoute({
  path: '/cluster-monitor',
  sidebar: 'cluster-monitor',
  name: 'cluster-monitor',
  exact: true,
  useClusterURL: true,
  component: () => <ClusterMonitorPage />,
});

registerSidebarEntry({
  parent: null,
  sidebar: 'IN-CLUSTER',
  name: 'sidebar-settings',
  label: 'Sidebar Settings',
  url: '/click-ops-sidebar-settings',
  icon: 'mdi:menu-open',
  useClusterURL: true,
});

registerRoute({
  path: '/click-ops-sidebar-settings',
  sidebar: 'sidebar-settings',
  name: 'sidebar-settings',
  exact: true,
  useClusterURL: true,
  component: () => <SidebarSettingsPage />,
});
