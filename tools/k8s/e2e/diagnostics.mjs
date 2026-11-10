// Read-only, bounded by the controller's command timeouts. Never dump whole Pods,
// annotations, environment, logs, ConfigMaps, Secrets, or arbitrary exception text.
import path from 'node:path';

const identity = object => ({ name: object.metadata?.name, namespace: object.metadata?.namespace });
const ports = values => (values || []).map(({ name, protocol, port, targetPort, containerPort, hostPort, hostIP, endPort }) =>
  ({ name, protocol, port, targetPort, containerPort, hostPort, hostIP, endPort }));
const podSummary = pod => ({
  ...identity(pod), node: pod.spec?.nodeName, ip: pod.status?.podIP, phase: pod.status?.phase,
  labels: Object.fromEntries(['app.kubernetes.io/part-of', 'workpartner/role'].flatMap(key =>
    pod.metadata?.labels?.[key] ? [[key, pod.metadata.labels[key]]] : [])),
  ready: pod.status?.conditions?.find(c => c.type === 'Ready')?.status,
  deleting: Boolean(pod.metadata?.deletionTimestamp),
  containers: (pod.spec?.containers || []).map(container => ({ name: container.name, ports: ports(container.ports) })),
  statuses: (pod.status?.containerStatuses || []).map(({ name, ready, restartCount, state }) =>
    ({ name, ready, restartCount, state: Object.keys(state || {}) })),
});
const policySummary = policy => ({
  ...identity(policy), podSelector: policy.spec?.podSelector, policyTypes: policy.spec?.policyTypes,
  ingress: policy.spec?.ingress?.map(({ from, ports: p }) => ({ from, ports: ports(p) })),
  egress: policy.spec?.egress?.map(({ to, ports: p }) => ({ to, ports: ports(p) })),
});
const probeSummary = result => ({ open: result.open, status: result.status,
  reason: /^(connected|timeout|E[A-Z0-9_]+)$/.test(result.reason || '') ? result.reason : undefined });

export async function collectPolicyDiagnostics(runtime, config, failedSlug) {
  const { namespace: users, systemNamespace: system } = config.organization.runtime.k8s;
  const { gatewayPort, internalPort, gatewayOrigin } = config.organization.runtime;
  const service = new URL(gatewayOrigin).hostname;
  const evidence = { failedSlug, configuredGatewayIp: config.gatewayIp, gatewayPort, internalPort, errors: [] };
  async function attempt(step, fn) {
    try { return await fn(); }
    catch (error) {
      evidence.errors.push({ step, status: 'unavailable', ...(error.logPath ? { log: path.basename(error.logPath) } : {}) });
      return undefined;
    }
  }
  const list = async (step, resource, namespace, selector) => {
    const result = await attempt(step, () => runtime.get(resource, namespace, selector));
    return result?.items || (result ? [result] : []);
  };
  const [gateways, userPods, services, slices, userPolicies, systemPolicies] = await Promise.all([
    list('gateway Pods', 'pods', system, `workpartner-e2e=${config.prefix},workpartner/role=gateway`),
    list('user Pods', 'pods', users),
    list('gateway Service', `service/${service}`, system),
    list('gateway EndpointSlices', 'endpointslices.discovery.k8s.io', system, `kubernetes.io/service-name=${service}`),
    list('user NetworkPolicies', 'networkpolicies', users),
    list('system NetworkPolicies', 'networkpolicies', system),
  ]);
  evidence.gatewayPods = gateways.map(podSummary);
  evidence.services = services.map(svc => ({ ...identity(svc), type: svc.spec?.type,
    clusterIP: svc.spec?.clusterIP, selector: svc.spec?.selector, ports: ports(svc.spec?.ports) }));
  evidence.endpointSlices = slices.map(slice => ({ ...identity(slice), addressType: slice.addressType,
    ports: ports(slice.ports), endpoints: (slice.endpoints || []).map(({ addresses, conditions, nodeName, targetRef }) =>
      ({ addresses, conditions, nodeName, targetRef: targetRef && { kind: targetRef.kind, name: targetRef.name, namespace: targetRef.namespace } })) }));
  evidence.networkPolicies = [...userPolicies, ...systemPolicies].map(policySummary);
  evidence.probes = [];
  const gateway = gateways.find(p => !p.metadata?.deletionTimestamp && p.status?.podIP === config.gatewayIp)
    || gateways.find(p => !p.metadata?.deletionTimestamp);
  const failedName = `${config.organization.runtime.nextContainerPrefix}${failedSlug}-0`;
  const sameNode = gateway?.spec?.nodeName && userPods.find(p => p.spec?.nodeName === gateway.spec.nodeName
    && p.metadata?.name !== failedName && !p.metadata?.deletionTimestamp && p.metadata?.labels?.['workpartner/role'] === 'user');
  const sources = userPods.filter(p => ['node-server', 'node-agent', failedSlug].some(slug =>
    p.metadata?.name === `${config.organization.runtime.nextContainerPrefix}${slug}-0`) || p === sameNode);
  evidence.userPods = sources.map(podSummary);
  evidence.sameNodeUserPods = sources.filter(p => gateway?.spec?.nodeName && p.spec?.nodeName === gateway.spec.nodeName).map(p => p.metadata.name);
  if (!gateway) evidence.errors.push({ step: 'gateway probes', status: 'no gateway Pod' });
  if (!evidence.sameNodeUserPods.length) evidence.errors.push({ step: 'same-node user probes', status: 'no same-node user Pod' });
  async function check(pod, container, target) {
    const source = { ...identity(pod), container };
    const result = await attempt(`probe ${source.name} ${target.kind} ${target.host}:${target.port}`,
      async () => probeSummary(await runtime.probe(source, target)));
    evidence.probes.push({ source, target, result: result || { status: 'unavailable' } });
  }
  if (gateway) {
    for (const host of ['127.0.0.1', gateway.status?.podIP].filter(Boolean)) {
      for (const port of [gatewayPort, internalPort]) await check(gateway, 'gateway', { kind: 'tcp', host, port });
      await check(gateway, 'gateway', { kind: 'http', host, port: gatewayPort });
    }
    if (gateway.status?.podIP) for (const pod of sources) {
      for (const port of [gatewayPort, internalPort]) await check(pod, 'workspace', { kind: 'tcp', host: gateway.status.podIP, port });
    }
  }
  evidence.guards = await Promise.all([config.serverNode, config.agentNode].map(async node => ({ node,
    ...(config.guard ? await attempt(`node-guard ${node}`, () => runtime.guard(node)) || { status: 'unavailable' }
      : { status: 'disabled' }),
  })));
  return evidence;
}
