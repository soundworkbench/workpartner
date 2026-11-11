/** Non-secret effective configuration of the existing single-organization deployment. */
export interface Organization {
  schemaVersion: 1;
  revision: string;
  organizationId: string;
  directory: string;
  productName: { zh: string; en: string };
  displayName: string;
  server: { publicHost: string; publicOrigin: string; legacyHosts: string[]; previewHost: string; projectHost: string };
  identity: { provider: 'feishu'; callbackPath: string; admission: 'pilot-group' | 'unrestricted'; appSecretFile: string; appId: string; pilotChatId: string };
  model: { quickLineModel?: string; codexProvider: string; baseUrl: string; keyPrefix: string; keyMode: 'exec' | 'pool'; defaultsFile: string; keyEnvironment: string; baseEnvironment: string; nextBaseUrl: string; catalog?: Record<'codex' | 'claude', { default?: string; id?: string; key?: string; name?: string; also?: string[] }[]>; defaults: { codex: string; claude: string; opus: string; sonnet: string; haiku: string; effort: string; language: string; claudePrefix: string }; provision: null | { container: string; command: string[]; keyPattern: string; models: string[] } };
  runtime: {
    /** Omitted selects Docker; Kubernetes defaults are applied by the consuming modules. */
    kind?: 'docker' | 'k8s';
    migration?: { ownersFile?: string; peerOrigin?: string };
    k8s?: {
      namespace?: string; systemNamespace?: string; systemContainer?: string; clusterDomain?: string;
      /** Optional resolver ndots (integer 1–15); omitted preserves cluster defaults. */
      dnsNdots?: number;
      storageClass?: string; dataVolumeSize?: string; newUserNodeSelector?: Record<string, string>;
      /** Same-named claims in system/user namespaces must expose the same shared filesystem. */
      sharedSkillsClaim?: string;
      memoryRequest?: string; cpuRequest?: string; userPriorityClass?: string;
      userResources?: Record<string, { memory?: string | number; cpu?: string | number }>;
      gatewayResources?: { cpu?: string; memory?: string };
      imageConfigMap?: string; governingService?: string; requiredPolicies?: string[];
      publishedDirectory?: string; publishedFiles?: string[];
      apiTimeoutMs?: number; podStartTimeoutMs?: number; terminationGraceSeconds?: number;
      inspectCacheMs?: number; keepRunningIntervalMs?: number; loadGatewayExtension?: boolean;
      /** File helper cache and staging lease durations, independent of inspectCacheMs. */
      cacheMs?: number; leaseTtlMs?: number;
      /** Prefer the mounted ServiceAccount; never commit a credential-bearing kubeconfig. */
      inCluster?: boolean | { server?: string; namespaceFile?: string; tokenFile?: string; caFile?: string };
      kubeconfigJson?: string | Record<string, unknown>;
      deploy?: {
        gatewayImage?: string; gatewayNodeSelector?: Record<string, string>;
        entry?: { mode: 'hostPort'; hostIP: string; hostPort: number }
          | { mode: 'clusterIP'; clusterIP: string };
        hostPaths?: { organization?: string; secure?: string; state?: string; usersFile?: string };
        egressExceptCidrs?: string[]; modelEgressSelector?: Record<string, string>;
        modelEgressEndpoint?: { address: string; port: number };
        newUserStorage?: { provisioner?: string; parameters?: Record<string, string> };
      };
    };
    modelContainer: string; nextImage: string; buildImage: string; baseImage: string; nextContainerPrefix: string; nextUserLabel: string;
    nextDirectory: string; nextModelKeyFile: string; nextMemory: number; nextPidsLimit: number; nextPort: number;
    packageDirectory: string; gatewayContainer: string; protectedUsers: string[]; rolloutData: string; rolloutSecure: string; rolloutKeyPrefix: string;
    project: string; image: string; gatewayImage: string; containerPrefix: string; userLabel: string;
    network: string; uid: number; memory: number; nanoCpus: number; pidsLimit: number;
    stateDirectory: string; gatewayPort: number; internalPort: number; webPort: number; gatewayOrigin: string; internalOrigin: string;
    localAddress: string; configDirectory: string; usersFile: string; usersDirectory: string;
    modelKeyFile: string; sessionKeyFile: string; secureDirectory: string; cookieFile: string;
    hostData: string; hostSecure: string; hostConfig: string;
  };
  appearance: { authorizationStyle?: string; brandDirectory: string; timezoneFallback: string; themeColor: string; avatarColor: string; gateway: Record<string, string>; copy?: Record<string, unknown> };
  market: { approvers: string[]; reservedPrefixes: string[]; protectedNames: string[]; sharedDirectory: string; containerDirectory: string; preinstalled: string[] };
  image: { officialSkillsArchive?: string; homeDirectory: string; instructions: string; legacyInstructions: string; skillTranslations: string; skills: string[] };
  mcpHub?: null | { url: string; name?: string; keyEnvironment: string; displayNames?: string; hidden?: string[];
    defaultCategory?: string; categories?: { zh: string; en: string }[];
    platform?: { id: string; name: { zh: string; en: string } };
    tools?: Record<string, { category?: string; platform?: { id: string; name: { zh: string; en: string } }; example?: { zh: string; en: string } }> };
  bridge: { template: string };
  tools?: { legacyRollout?: string };
  features: { feishuAuthorization: boolean; feishuOnboarding: boolean; marketSkills: boolean; autoTitle: boolean; preview: boolean };
  extensions: { configFiles: string[]; gatewayModule: string };
  dataTools?: { catalog: string; blockedPrefixes?: string[]; legacyPassthrough?: string[]; usageAliases?: string[]; provider: {
    origin: string; tokenFile: string; orgIdEnvironment: string; orgSlugEnvironment: string;
    enabledEnvironment: string; verifiedEnvironment: string; overridesFile?: string;
    limitEnvironment: Record<'daily' | 'monthly' | 'call', string>;
    budgetPath: string; callPath: string; usagePath?: string;
    headers: Record<'token' | 'organization' | 'tag' | 'routeMax' | 'cost' | 'callId', string>;
  } };
}
/** Read locally shipped data and existing environment overrides; never reads credentials or writes profiles. */
export function resolveOrganization(environment?: NodeJS.ProcessEnv): Organization;
/** Return only the pre-existing public desktop fields. */
export function desktopPublicConfig(environment: NodeJS.ProcessEnv, packaged?: { PUBLIC_HOST?: unknown; MEEGLE_HOST?: unknown }): { PUBLIC_HOST: string; MEEGLE_HOST: string };
/** Non-secret release data before deployment overrides. */
export type OrganizationData = Omit<Organization, "server" | "runtime"> & { publicHost?: string; previewHost?: string; legacyHosts?: string[]; projectHost?: string; runtime: Omit<Organization["runtime"], "hostData" | "hostSecure" | "hostConfig" | "modelContainer"> & { modelContainer: string | null } };
/** Read organization data without requiring deployment endpoints. */
export function organizationData(environment?: NodeJS.ProcessEnv): OrganizationData;
/** Resolve next image startup variables without reading a credential. */
export function nextEnvironment(organization: OrganizationData, environment?: NodeJS.ProcessEnv): Record<string, string>;
/** Resolve and validate model defaults and the runtime browser catalog. */
export function nextModelConfig(organization: OrganizationData, environment?: NodeJS.ProcessEnv): {
  quickLineModel?: string;
  defaults: Organization['model']['defaults'];
  catalog: Record<'codex' | 'claude', { id: string; key: string; name: string; also: string[] }[]>;
};
