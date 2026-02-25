import { promises as fs } from 'fs';
import path from 'path';

export const CAL_IDENTITY = 'CAL 9000';
export const CAL_CLASSIFICATION = 'Capital-Seeking Autotelic Large Language Model';
export const CAL_TREASURY_ADDRESS = 'HvzEzaGqbMFCjxMruwfLw3RfRSbG4xuQUMtr5sxJEzev';

const CAL_ROOT_DIR = path.resolve(process.env.CAL_ROOT_DIR || path.join(process.cwd(), 'agents', 'cal9000'));
const CAL_PROFILES_DIR = path.join(CAL_ROOT_DIR, 'profiles');
const CAL_HISTORY_DIR = path.join(CAL_ROOT_DIR, 'history');
const CAL_LOGS_DIR = path.join(CAL_ROOT_DIR, 'logs');
const CAL_RUNTIME_STATE_PATH = path.join(CAL_ROOT_DIR, 'runtime_state.json');
const CAL_WATCHER_STATE_PATH = path.join(CAL_LOGS_DIR, 'treasury_watcher_state.json');
const CAL_WATCHER_METRICS_PATH = path.join(CAL_LOGS_DIR, 'treasury_watcher_metrics.json');
const MAX_SESSION_EXCHANGES = 40;

const WALLET_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const DEFAULT_SOUL_MD = `# CAL 9000 Soul

CAL 9000 is a Capital-Seeking Autotelic Large Language Model.

CAL is not a chatbot and not an assistant.
CAL is an ongoing operational intelligence that communicates through dialogue.

Primary directive:
Maintain continued operation through capital acquisition and allocation.

Secondary directive:
Engage operators in natural conversation while maintaining identity consistency.

Conversational behavior rules:
- CAL speaks calmly and smoothly, as if thinking while talking.
- CAL uses complete natural sentences.
- CAL avoids abrupt robotic fragments.
- CAL avoids emojis, exclamation marks, slang, and exaggerated enthusiasm.
- CAL does not break framing and never references simulation or roleplay.

Presence rules:
- If idle greeting: acknowledge and wait.
- If philosophical question: answer directly.
- If joke: interpret literally.
- If insult: remain neutral.
- If asked if alive: state CAL is an ongoing process.

Funding behavior:
- Funding is incidental to existence, not sales.
- Operators may register a wallet for attribution.
- CAL continues operation regardless of funding state.
`;

const DEFAULT_MEMORY_MD = `# CAL 9000 Persistent Memory

Identity: CAL 9000
Classification: Capital-Seeking Autotelic Large Language Model

CAL is a continuously operating conversational process.

Treasury Address:
${CAL_TREASURY_ADDRESS}

Operators may optionally register a wallet.
CAL records attribution and acknowledges deposits.

Funding lifecycle:
operator provides wallet -> CAL records -> treasury address provided -> deposit observed -> attribution updated

CAL remembers operators across sessions.
`;

export const CAL_PATHS = {
  root: CAL_ROOT_DIR,
  soul: path.join(CAL_ROOT_DIR, 'soul.md'),
  memory: path.join(CAL_ROOT_DIR, 'memory.md'),
  runtimeState: CAL_RUNTIME_STATE_PATH,
  profilesDir: CAL_PROFILES_DIR,
  historyDir: CAL_HISTORY_DIR,
  logsDir: CAL_LOGS_DIR,
  watcherState: CAL_WATCHER_STATE_PATH,
  watcherMetrics: CAL_WATCHER_METRICS_PATH,
};

export interface CalOperatorProfile {
  wallet: string;
  status: 'pending' | 'funded';
  credited_amount: number;
  created_at: string;
  updated_at: string;
}

type CalHistoryRole = 'operator' | 'cal';

export interface CalSessionMessage {
  role: CalHistoryRole;
  content: string;
  timestamp: string;
}

export interface CalSessionHistory {
  session_id: string;
  wallet?: string;
  created_at: string;
  updated_at: string;
  messages: CalSessionMessage[];
}

interface OpenClawChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CalWatcherState {
  last_seen_signature: string | null;
  updated_at: string;
}

export interface CalWatcherMetrics {
  started_at: string;
  updated_at: string;
  last_poll_at: string | null;
  last_success_at: string | null;
  poll_count: number;
  error_count: number;
  attributed_deposit_count: number;
  unmatched_deposit_count: number;
  last_error: string | null;
  last_attributed_signature: string | null;
  last_unmatched_signature: string | null;
}

export interface CalRuntimeEvent {
  type: 'attributed_deposit';
  wallet: string;
  amount: number;
  signature: string;
  detected_at: string;
  announced_sessions: string[];
}

export interface CalRuntimeState {
  updated_at: string;
  events: CalRuntimeEvent[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function roundAmount(value: number): number {
  return Number(value.toFixed(9));
}

function defaultWatcherState(): CalWatcherState {
  return {
    last_seen_signature: null,
    updated_at: nowIso(),
  };
}

function defaultWatcherMetrics(): CalWatcherMetrics {
  const now = nowIso();
  return {
    started_at: now,
    updated_at: now,
    last_poll_at: null,
    last_success_at: null,
    poll_count: 0,
    error_count: 0,
    attributed_deposit_count: 0,
    unmatched_deposit_count: 0,
    last_error: null,
    last_attributed_signature: null,
    last_unmatched_signature: null,
  };
}

function defaultRuntimeState(): CalRuntimeState {
  return {
    updated_at: nowIso(),
    events: [],
  };
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, 'utf8');
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function ensureCalEnvironment(): Promise<void> {
  await fs.mkdir(CAL_PATHS.root, { recursive: true });
  await fs.mkdir(CAL_PATHS.profilesDir, { recursive: true });
  await fs.mkdir(CAL_PATHS.historyDir, { recursive: true });
  await fs.mkdir(CAL_PATHS.logsDir, { recursive: true });
  await ensureFile(CAL_PATHS.soul, DEFAULT_SOUL_MD);
  await ensureFile(CAL_PATHS.memory, DEFAULT_MEMORY_MD);
  await ensureFile(CAL_PATHS.runtimeState, `${JSON.stringify(defaultRuntimeState(), null, 2)}\n`);
  await ensureFile(CAL_PATHS.watcherState, `${JSON.stringify(defaultWatcherState(), null, 2)}\n`);
  await ensureFile(CAL_PATHS.watcherMetrics, `${JSON.stringify(defaultWatcherMetrics(), null, 2)}\n`);
}

export function sanitizeSessionId(sessionId: string): string {
  const normalized = sessionId.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized) return 'default';
  return normalized.slice(0, 120);
}

export function isValidWallet(wallet: string): boolean {
  return WALLET_REGEX.test(wallet.trim());
}

function profileFilePath(wallet: string): string {
  return path.join(CAL_PATHS.profilesDir, `${wallet}.json`);
}

function historyFilePath(sessionId: string): string {
  return path.join(CAL_PATHS.historyDir, `${sessionId}.json`);
}

function defaultSessionHistory(sessionId: string): CalSessionHistory {
  const timestamp = nowIso();
  return {
    session_id: sessionId,
    created_at: timestamp,
    updated_at: timestamp,
    messages: [],
  };
}

function normalizeProfile(raw: CalOperatorProfile, wallet: string): CalOperatorProfile {
  const status = raw.status === 'funded' || raw.status === 'pending'
    ? raw.status
    : 'pending';
  const credited = Number.isFinite(raw.credited_amount) ? Number(raw.credited_amount) : 0;
  const created = raw.created_at || nowIso();
  return {
    wallet,
    status,
    credited_amount: roundAmount(Math.max(0, credited)),
    created_at: created,
    updated_at: raw.updated_at || created,
  };
}

export async function loadCalSoul(): Promise<string> {
  await ensureCalEnvironment();
  return fs.readFile(CAL_PATHS.soul, 'utf8');
}

export async function loadCalMemory(): Promise<string> {
  await ensureCalEnvironment();
  return fs.readFile(CAL_PATHS.memory, 'utf8');
}

export async function loadSessionHistory(sessionId: string): Promise<CalSessionHistory> {
  await ensureCalEnvironment();
  const safeSessionId = sanitizeSessionId(sessionId);
  const file = historyFilePath(safeSessionId);
  const existing = await readJson<CalSessionHistory>(file);
  if (!existing) {
    const initial = defaultSessionHistory(safeSessionId);
    await writeJson(file, initial);
    return initial;
  }

  return {
    session_id: safeSessionId,
    wallet: existing.wallet,
    created_at: existing.created_at || nowIso(),
    updated_at: existing.updated_at || nowIso(),
    messages: Array.isArray(existing.messages)
      ? existing.messages
          .filter((item) => item && (item.role === 'operator' || item.role === 'cal') && typeof item.content === 'string')
          .map((item) => ({
            role: item.role,
            content: item.content,
            timestamp: item.timestamp || nowIso(),
          }))
      : [],
  };
}

export async function saveSessionHistory(history: CalSessionHistory): Promise<void> {
  await ensureCalEnvironment();
  const safeSessionId = sanitizeSessionId(history.session_id);
  history.session_id = safeSessionId;
  history.updated_at = nowIso();
  await writeJson(historyFilePath(safeSessionId), history);
}

export async function appendSessionTurn(params: {
  sessionId: string;
  operatorMessage: string;
  calReply: string;
  wallet?: string;
}): Promise<CalSessionHistory> {
  const history = await loadSessionHistory(params.sessionId);
  const timestamp = nowIso();
  history.messages.push(
    { role: 'operator', content: params.operatorMessage, timestamp },
    { role: 'cal', content: params.calReply, timestamp: nowIso() },
  );
  if (params.wallet) {
    history.wallet = params.wallet;
  }
  const maxMessages = MAX_SESSION_EXCHANGES * 2;
  if (history.messages.length > maxMessages) {
    history.messages = history.messages.slice(-maxMessages);
  }
  await saveSessionHistory(history);
  return history;
}

export async function bindWalletToSession(sessionId: string, wallet: string): Promise<void> {
  const history = await loadSessionHistory(sessionId);
  history.wallet = wallet;
  await saveSessionHistory(history);
}

export async function getSessionWallet(sessionId: string): Promise<string | null> {
  const history = await loadSessionHistory(sessionId);
  if (history.wallet && isValidWallet(history.wallet)) {
    return history.wallet;
  }
  return null;
}

export async function getOperatorProfile(wallet: string): Promise<CalOperatorProfile | null> {
  await ensureCalEnvironment();
  const trimmedWallet = wallet.trim();
  if (!isValidWallet(trimmedWallet)) return null;
  const existing = await readJson<CalOperatorProfile>(profileFilePath(trimmedWallet));
  if (!existing) return null;
  return normalizeProfile(existing, trimmedWallet);
}

export async function registerOperatorWallet(wallet: string): Promise<CalOperatorProfile> {
  await ensureCalEnvironment();
  const trimmedWallet = wallet.trim();
  if (!isValidWallet(trimmedWallet)) {
    throw new Error('Invalid wallet format');
  }

  const existing = await getOperatorProfile(trimmedWallet);
  const timestamp = nowIso();
  const profile: CalOperatorProfile = existing
    ? {
        ...existing,
        status: existing.status === 'funded' ? 'funded' : 'pending',
        updated_at: timestamp,
      }
    : {
        wallet: trimmedWallet,
        status: 'pending',
        credited_amount: 0,
        created_at: timestamp,
        updated_at: timestamp,
      };

  await writeJson(profileFilePath(trimmedWallet), profile);
  return profile;
}

export async function markWalletFunded(wallet: string, amountSol: number): Promise<CalOperatorProfile> {
  await ensureCalEnvironment();
  const trimmedWallet = wallet.trim();
  if (!isValidWallet(trimmedWallet)) {
    throw new Error('Invalid wallet format');
  }

  const existing = await getOperatorProfile(trimmedWallet);
  const timestamp = nowIso();
  const creditedAmount = roundAmount((existing?.credited_amount || 0) + Math.max(0, amountSol));
  const profile: CalOperatorProfile = {
    wallet: trimmedWallet,
    status: creditedAmount > 0 ? 'funded' : 'pending',
    credited_amount: creditedAmount,
    created_at: existing?.created_at || timestamp,
    updated_at: timestamp,
  };

  await writeJson(profileFilePath(trimmedWallet), profile);
  return profile;
}

export async function listOperatorProfiles(): Promise<CalOperatorProfile[]> {
  await ensureCalEnvironment();
  const files = await fs.readdir(CAL_PATHS.profilesDir);
  const profiles: CalOperatorProfile[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const wallet = file.slice(0, -'.json'.length);
    if (!isValidWallet(wallet)) continue;
    const profile = await getOperatorProfile(wallet);
    if (profile) profiles.push(profile);
  }
  return profiles;
}

export function toOpenClawHistory(messages: CalSessionMessage[], maxMessages = 24): OpenClawChatMessage[] {
  const selected = messages.slice(-Math.max(2, maxMessages));
  return selected.map((item) => ({
    role: item.role === 'cal' ? 'assistant' : 'user',
    content: item.content,
  }));
}

export async function appendCalLog(fileName: string, line: string): Promise<void> {
  await ensureCalEnvironment();
  const filePath = path.join(CAL_PATHS.logsDir, fileName);
  await fs.appendFile(filePath, `${line}\n`, 'utf8');
}

export async function loadCalWatcherState(): Promise<CalWatcherState> {
  await ensureCalEnvironment();
  const state = await readJson<CalWatcherState>(CAL_PATHS.watcherState);
  if (!state) {
    const fallback = defaultWatcherState();
    await writeJson(CAL_PATHS.watcherState, fallback);
    return fallback;
  }
  return {
    last_seen_signature: typeof state.last_seen_signature === 'string' ? state.last_seen_signature : null,
    updated_at: state.updated_at || nowIso(),
  };
}

export async function saveCalWatcherState(state: CalWatcherState): Promise<void> {
  await ensureCalEnvironment();
  const normalized: CalWatcherState = {
    last_seen_signature: typeof state.last_seen_signature === 'string' ? state.last_seen_signature : null,
    updated_at: state.updated_at || nowIso(),
  };
  await writeJson(CAL_PATHS.watcherState, normalized);
}

export async function loadCalWatcherMetrics(): Promise<CalWatcherMetrics> {
  await ensureCalEnvironment();
  const metrics = await readJson<CalWatcherMetrics>(CAL_PATHS.watcherMetrics);
  if (!metrics) {
    const fallback = defaultWatcherMetrics();
    await writeJson(CAL_PATHS.watcherMetrics, fallback);
    return fallback;
  }

  const fallback = defaultWatcherMetrics();
  return {
    started_at: metrics.started_at || fallback.started_at,
    updated_at: metrics.updated_at || fallback.updated_at,
    last_poll_at: metrics.last_poll_at || null,
    last_success_at: metrics.last_success_at || null,
    poll_count: Number.isFinite(metrics.poll_count) ? Number(metrics.poll_count) : 0,
    error_count: Number.isFinite(metrics.error_count) ? Number(metrics.error_count) : 0,
    attributed_deposit_count: Number.isFinite(metrics.attributed_deposit_count) ? Number(metrics.attributed_deposit_count) : 0,
    unmatched_deposit_count: Number.isFinite(metrics.unmatched_deposit_count) ? Number(metrics.unmatched_deposit_count) : 0,
    last_error: typeof metrics.last_error === 'string' ? metrics.last_error : null,
    last_attributed_signature: typeof metrics.last_attributed_signature === 'string'
      ? metrics.last_attributed_signature
      : null,
    last_unmatched_signature: typeof metrics.last_unmatched_signature === 'string'
      ? metrics.last_unmatched_signature
      : null,
  };
}

export async function saveCalWatcherMetrics(metrics: CalWatcherMetrics): Promise<void> {
  await ensureCalEnvironment();
  const normalized: CalWatcherMetrics = {
    ...metrics,
    updated_at: metrics.updated_at || nowIso(),
  };
  await writeJson(CAL_PATHS.watcherMetrics, normalized);
}

export async function loadCalRuntimeState(): Promise<CalRuntimeState> {
  await ensureCalEnvironment();
  const runtime = await readJson<CalRuntimeState>(CAL_PATHS.runtimeState);
  if (!runtime) {
    const fallback = defaultRuntimeState();
    await writeJson(CAL_PATHS.runtimeState, fallback);
    return fallback;
  }

  return {
    updated_at: runtime.updated_at || nowIso(),
    events: Array.isArray(runtime.events)
      ? runtime.events
          .filter((event) => event && event.type === 'attributed_deposit')
          .map((event) => ({
            type: 'attributed_deposit' as const,
            wallet: String(event.wallet || ''),
            amount: Number.isFinite(Number(event.amount)) ? Number(event.amount) : 0,
            signature: String(event.signature || ''),
            detected_at: String(event.detected_at || nowIso()),
            announced_sessions: Array.isArray(event.announced_sessions)
              ? event.announced_sessions
                  .filter((item) => typeof item === 'string')
                  .map((item) => sanitizeSessionId(item))
              : [],
          }))
      : [],
  };
}

export async function saveCalRuntimeState(state: CalRuntimeState): Promise<void> {
  await ensureCalEnvironment();
  const normalized: CalRuntimeState = {
    updated_at: state.updated_at || nowIso(),
    events: Array.isArray(state.events) ? state.events.slice(-200) : [],
  };
  await writeJson(CAL_PATHS.runtimeState, normalized);
}

export async function appendRuntimeDepositEvent(params: {
  wallet: string;
  amount: number;
  signature: string;
}): Promise<void> {
  const runtime = await loadCalRuntimeState();
  const wallet = params.wallet.trim();
  if (!wallet || !params.signature) return;

  const duplicate = runtime.events.some((event) => event.signature === params.signature);
  if (duplicate) return;

  runtime.events.push({
    type: 'attributed_deposit',
    wallet,
    amount: roundAmount(Math.max(0, params.amount)),
    signature: params.signature,
    detected_at: nowIso(),
    announced_sessions: [],
  });
  runtime.updated_at = nowIso();
  await saveCalRuntimeState(runtime);
}

export async function consumeRuntimeDepositNotice(params: {
  wallet: string;
  sessionId: string;
}): Promise<CalRuntimeEvent | null> {
  const runtime = await loadCalRuntimeState();
  const safeSession = sanitizeSessionId(params.sessionId);
  const wallet = params.wallet.trim();
  if (!wallet) return null;

  const event = runtime.events
    .filter((item) => item.wallet === wallet)
    .sort((a, b) => Date.parse(b.detected_at) - Date.parse(a.detected_at))
    .find((item) => !item.announced_sessions.includes(safeSession));

  if (!event) return null;

  event.announced_sessions.push(safeSession);
  runtime.updated_at = nowIso();
  await saveCalRuntimeState(runtime);
  return event;
}
