import type { HarnessCommand } from './commands';
import type { AccentColor } from './appearance';
import type { FileReference } from './preview-link';

export const bundledHarnesses = ['deepseek', 'zcode'] as const;
export const agentHarnesses = ['kimi', 'opencode', 'codex'] as const;
export const harnesses = [...bundledHarnesses, ...agentHarnesses] as const;
export type BundledHarness = typeof bundledHarnesses[number];
export type AgentHarness = typeof agentHarnesses[number];
export type Harness = typeof harnesses[number];
export type RunState = 'idle' | 'starting' | 'running' | 'waiting' | 'stopping' | 'syncing' | 'error';
export const activeRunStates = new Set<RunState>(['starting', 'running', 'waiting', 'stopping', 'syncing']);
export interface LaunchConfig { executable: string; args: string[]; home: string; provider: string; model: string; reasoning?: string; authMode: 'native' | 'api'; baseUrl: string; isolatedNative?: boolean; }
export interface HistoryPreferences {
  autoImport: boolean; autoExport: boolean;
  importScope?: 'selected' | 'all'; exportScope?: 'selected' | 'all';
  sources?: Partial<Record<Harness, string>>;
}
export interface HarnessStartup { followLast: boolean; additional: Harness[]; }
export type HarnessUpdatePreferences = Partial<Record<Harness, boolean>>;
export interface HarnessUpdateStatus {
  version?: string;
  pending?: string;
  state: 'idle' | 'checking' | 'preparing' | 'ready' | 'current' | 'error' | 'external';
  detail?: string;
}
export type HarnessUpdates = Record<Harness, HarnessUpdateStatus>;
export interface RuntimeSelection { harness: Harness; conversationId?: string; }
export type Theme = 'light' | 'dark' | 'system';
export type QuotaRegion = 'auto' | 'zai' | 'bigmodel';
export interface Settings { deepseek: LaunchConfig; zcode: LaunchConfig; agents?: Partial<Record<AgentHarness, LaunchConfig>>; defaultWorkspace: string; history?: HistoryPreferences; startup?: HarnessStartup; harnessUpdates?: HarnessUpdatePreferences; autoAppUpdate?: boolean; theme?: Theme; accentColor?: AccentColor; quotaRegion?: QuotaRegion; }
export interface AppUpdateStatus {
  version: string; state: 'portable' | 'unconfigured' | 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'installing' | 'error';
  available?: string; notes?: string; downloaded?: number; total?: number; detail?: string;
}
export interface ConnectionKeys extends Partial<Record<Harness, string>> { zcodeUsage?: string | null; }
export interface ReasoningLevel { id: string; label: string; nativeValue: string; }
export interface ModelReasoning { modelId: string; harness: Harness; levels: ReasoningLevel[]; defaultLevel?: string; sourceUrl?: string; verifiedAt?: string; }
export interface NativeModel { id: string; label: string; }
export interface NativeModelCatalog { models: NativeModel[]; currentModel?: string; reasoning: ModelReasoning; }
export interface HistorySyncStatus { running: boolean; lastSyncAt?: number; imported: number; exported: number; issues: string[]; }
export interface SettingsView extends Settings { hasDeepseekKey: boolean; hasZcodeKey: boolean; hasZcodeUsageKey: boolean; hasAgentKeys?: Partial<Record<AgentHarness, boolean>>; }
export interface ContextUsage {
  harness: Harness;
  modelId: string;
  revision: number;
  usedTokens: number;
  windowTokens: number;
  source: 'reported' | 'native-estimate';
}
export interface UsageWindow {
  name: string;
  remainingPercent: number;
  resetAt?: number;
}
export interface WalletBalance {
  name: string;
  currency: string;
  amount: string;
}
export type UsageSection<T> =
  | { status: 'ready'; rows: T[]; source: string }
  | { status: 'unavailable' | 'not-connected' | 'error'; detail: string };
export interface AccountUsage {
  harness: Harness;
  authMode: LaunchConfig['authMode'];
  checkedAt: number;
  plan: UsageSection<UsageWindow>;
  balance: UsageSection<WalletBalance>;
  consoleUrl?: string;
}
export type TokenDay = { day: string } & Record<Harness, number>;
export interface NativeBinding {
  sessionId: string;
  revision: number;
  location?: string;
  translated?: true;
  nativeCheckpoint?: { version: string; content: string; turnId?: number };
  seed?: { file: string; view: 'resume' | 'archive' };
}
export interface NativeHistorySource { harness: Harness; location: string; }
export interface NativeHistory { id: string; title: string; workspace: string; createdAt: number; updatedAt: number; version?: string; busy?: boolean; sync?: { joined: boolean; allowed: boolean; session?: boolean; project?: boolean }; }
export interface NativeHistoryList { source: NativeHistorySource; sessions: NativeHistory[]; warnings: string[]; }
export type HistoryExportScope = { kind: 'project'; workspace: string } | { kind: 'conversation'; id: string };
export type HistoryExportRules = Partial<Record<Harness, boolean>>;
export interface HistoryExportSelection { rules: HistoryExportRules; inherited: Record<Harness, boolean>; enabled: boolean; }
export type HistoryImportRule = { source: NativeHistorySource; enabled: boolean | null } & ({ sessionId: string } | { workspace: string });
export interface HistoryImport { source: NativeHistorySource; sessionId: string; workspace?: string; }
export interface HistoryExport { conversationId: string; target: NativeHistorySource; }
export interface ExportReceipt { harness: Harness; sessionId: string; location: string; workspace: string; backup?: string; verified: boolean; reused?: true; }
export interface Conversation {
  id: string; title: string; workspace: string; harness: Harness;
  createdAt: number; updatedAt: number; revision: number; state: RunState;
  bindings: Partial<Record<Harness, NativeBinding>>; canonicalPath?: string;
  modelId?: string; harnessMode?: 'auto' | 'manual';
  error?: string; lastSyncAt?: number;
  importedFrom?: NativeHistorySource & { sessionId: string; importedAt: number };
  reasoningByModel?: Record<string, string>;
  workspaceMissing?: boolean;
  externalMirror?: boolean;
  contextUsage?: ContextUsage;
}
export interface DisplayItem {
  id: string; kind: 'user' | 'assistant' | 'reasoning' | 'tool' | 'command' | 'notice' | 'error';
  text: string; harness: Harness; time: number; toolName?: string; commandName?: string; input?: string;
  status?: 'running' | 'done' | 'error';
}
export interface Approval { id: string; conversationId: string; kind: 'permission' | 'question'; title: string; detail: string; raw: unknown; }
export interface RuntimeHealth { harness: Harness; available: boolean; executable: string; detail: string; }
export interface Bootstrap { conversations: Conversation[]; projects: string[]; settings: SettingsView; health: RuntimeHealth[]; dataDir: string; reasoning: ModelReasoning[]; historySync: HistorySyncStatus; startupRoute?: RuntimeSelection; }
export type DesktopEvent =
  | { type: 'app-update'; status: AppUpdateStatus }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'item'; conversationId: string; item: DisplayItem }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval-cleared'; id: string }
  | { type: 'diagnostic'; conversationId: string; message: string }
  | { type: 'history-sync'; status: HistorySyncStatus }
  | { type: 'harness-updates'; status: HarnessUpdates }
  | { type: 'history-updated'; conversation: Conversation };
export interface ContextDetails { canonical: unknown; path: string | null; nativeEvents: number; }
export interface ProjectFile { name: string; path: string; kind: 'directory' | 'file' | 'link'; }
export interface DirectoryListing { entries: ProjectFile[]; truncated: boolean; }
export interface FilePreview {
  path: string; parent: string; text: string; binary: boolean; truncated: boolean; size: number;
  image?: { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/bmp'; base64: string };
}
export interface GitChange { path: string; oldPath?: string; index: string; worktree: string; }
export interface GitStatus { available: boolean; repository: boolean; branch: string; changes: GitChange[]; }
export interface DiffPreview { path: string; parent: string; staged: string; unstaged: string; truncated: boolean; }
export interface DesktopApi {
  appUpdateStatus(): Promise<AppUpdateStatus>;
  checkAppUpdate(): Promise<AppUpdateStatus>;
  installAppUpdate(): Promise<void>;
  launchAgentLogin(harness: 'kimi' | 'codex'): Promise<void>;
  nativeModels(scope: { harness: AgentHarness; workspace: string; modelId: string }): Promise<NativeModelCatalog>;
  listCommands(scope: { harness: Harness; workspace: string; modelId: string; id?: string }): Promise<HarnessCommand[]>;
  syncHistory(): Promise<HistorySyncStatus>;
  historySyncStatus(): Promise<HistorySyncStatus>;
  harnessUpdateStatus(): Promise<HarnessUpdates>;
  checkHarnessUpdates(): Promise<HarnessUpdates>;
  selectReasoning(id: string, level?: string): Promise<Conversation>;
  relocateConversation(id: string, workspace: string): Promise<Conversation>;
  historyDefaults(): Promise<Record<Harness, NativeHistorySource>>;
  listHistory(source: NativeHistorySource): Promise<NativeHistoryList>;
  historyExportSelection(scope: HistoryExportScope): Promise<HistoryExportSelection>;
  setHistoryExportSelection(scope: HistoryExportScope, rules: HistoryExportRules): Promise<HistoryExportSelection>;
  setHistoryImportRule(rule: HistoryImportRule): Promise<void>;
  importHistory(request: HistoryImport): Promise<Conversation>;
  exportHistory(request: HistoryExport): Promise<ExportReceipt>;
  chooseDatabase(): Promise<string | null>;
  bootstrap(): Promise<Bootstrap>;
  rememberRuntime(selection: RuntimeSelection): Promise<void>;
  addProject(workspace: string): Promise<string>;
  createProject(parent: string, name: string): Promise<string>;
  accountUsage(harness: Harness, refresh?: boolean): Promise<AccountUsage>;
  tokenActivity(): Promise<TokenDay[]>;
  createConversation(workspace: string, harness: Harness): Promise<Conversation>;
  loadConversation(id: string): Promise<{ conversation: Conversation; items: DisplayItem[] }>;
  send(id: string, text: string): Promise<void>;
  stop(id: string): Promise<void>;
  switchHarness(id: string, harness: Harness): Promise<Conversation>;
  selectModel(id: string, modelId: string, harness?: Harness): Promise<Conversation>;
  saveSettings(settings: Settings, keys?: ConnectionKeys): Promise<SettingsView>;
  chooseDirectory(): Promise<string | null>;
  chooseExecutable(): Promise<string | null>;
  context(id: string): Promise<ContextDetails>;
  answerApproval(id: string, allow: boolean, answer?: string): Promise<void>;
  openPath(path: string): Promise<void>;
  openLink(url: string): Promise<void>;
  exportContext(id: string): Promise<string | null>;
  listFiles(workspace: string, relativePath?: string): Promise<DirectoryListing>;
  readFile(workspace: string, relativePath: string): Promise<FilePreview>;
  readFileReference(workspace: string, reference: FileReference): Promise<FilePreview>;
  gitStatus(workspace: string): Promise<GitStatus>;
  gitDiff(workspace: string, relativePath: string): Promise<DiffPreview>;
  onEvent(callback: (event: DesktopEvent) => void): () => void;
}
