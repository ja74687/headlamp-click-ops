import { registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import AccessBuilderPage from './AccessBuilderPage';
import ResourceBuilderPage from './ResourceBuilderPage';

// eslint-disable-next-line no-console
console.log('[access-builder] plugin loaded');

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
