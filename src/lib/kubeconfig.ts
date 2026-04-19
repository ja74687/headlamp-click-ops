import yaml from 'js-yaml';

export type KubeconfigInput = {
  clusterName: string;
  serverUrl: string;
  caCrtBase64: string;
  userName: string;
  token: string;
  namespace: string;
  insecureSkipTlsVerify?: boolean;
};

export function buildKubeconfig(input: KubeconfigInput): string {
  const contextName = `${input.userName}@${input.clusterName}`;
  const clusterEntry: Record<string, unknown> = {
    server: input.serverUrl,
  };
  if (input.insecureSkipTlsVerify) {
    clusterEntry['insecure-skip-tls-verify'] = true;
  } else if (input.caCrtBase64) {
    clusterEntry['certificate-authority-data'] = input.caCrtBase64;
  }

  const config = {
    apiVersion: 'v1',
    kind: 'Config',
    'current-context': contextName,
    clusters: [{ name: input.clusterName, cluster: clusterEntry }],
    contexts: [
      {
        name: contextName,
        context: {
          cluster: input.clusterName,
          namespace: input.namespace,
          user: input.userName,
        },
      },
    ],
    users: [{ name: input.userName, user: { token: input.token } }],
    preferences: {},
  };

  return yaml.dump(config, { noRefs: true, lineWidth: -1 });
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/yaml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
