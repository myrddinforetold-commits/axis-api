import {
  CAL_TREASURY_ADDRESS,
  CalWatcherMetrics,
  appendRuntimeDepositEvent,
  appendCalLog,
  ensureCalEnvironment,
  getOperatorProfile,
  loadCalWatcherMetrics,
  loadCalWatcherState,
  markWalletFunded,
  saveCalWatcherMetrics,
  saveCalWatcherState,
} from '../lib/cal-storage';

const CAL_SOLANA_RPC_URL = process.env.CAL_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const POLL_INTERVAL_MS = Number(process.env.CAL_TREASURY_POLL_INTERVAL_MS || 30000);
const LAMPORTS_PER_SOL = 1_000_000_000;

interface SolanaSignatureEntry {
  signature: string;
}

interface SolanaRpcResponse<T> {
  result?: T;
  error?: {
    code: number;
    message: string;
  };
}

interface TransferEvent {
  signature: string;
  source: string;
  destination: string;
  lamports: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(CAL_SOLANA_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP error ${response.status}`);
  }

  const body = await response.json() as SolanaRpcResponse<T>;
  if (body.error) {
    throw new Error(`RPC error ${body.error.code}: ${body.error.message}`);
  }
  if (body.result === undefined) {
    throw new Error(`RPC ${method} returned empty result`);
  }
  return body.result;
}

function parseTransferEvents(signature: string, transaction: any): TransferEvent[] {
  const events: TransferEvent[] = [];
  const meta = transaction?.meta;
  if (meta?.err) return events;

  const instructions: any[] = [];
  const baseInstructions = transaction?.transaction?.message?.instructions;
  if (Array.isArray(baseInstructions)) {
    instructions.push(...baseInstructions);
  }
  const inner = meta?.innerInstructions;
  if (Array.isArray(inner)) {
    for (const group of inner) {
      if (Array.isArray(group?.instructions)) {
        instructions.push(...group.instructions);
      }
    }
  }

  for (const instruction of instructions) {
    const parsed = instruction?.parsed;
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.type !== 'transfer') continue;

    const info = parsed.info;
    if (!info || typeof info !== 'object') continue;
    const source = info.source;
    const destination = info.destination;
    const lamports = Number(info.lamports || 0);

    if (
      typeof source === 'string' &&
      typeof destination === 'string' &&
      destination === CAL_TREASURY_ADDRESS &&
      Number.isFinite(lamports) &&
      lamports > 0
    ) {
      events.push({ signature, source, destination, lamports });
    }
  }

  return events;
}

async function pollTreasuryOnce(metrics: CalWatcherMetrics): Promise<void> {
  const state = await loadCalWatcherState();
  const signatures = await rpcCall<SolanaSignatureEntry[]>(
    'getSignaturesForAddress',
    [CAL_TREASURY_ADDRESS, { limit: 100, commitment: 'confirmed' }],
  );

  if (signatures.length === 0) return;

  const newSignatures: string[] = [];
  for (const item of signatures) {
    if (item.signature === state.last_seen_signature) break;
    newSignatures.push(item.signature);
  }

  for (const signature of newSignatures.reverse()) {
    const transaction = await rpcCall<any>(
      'getTransaction',
      [signature, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    );
    const transfers = parseTransferEvents(signature, transaction);

    for (const transfer of transfers) {
      const profile = await getOperatorProfile(transfer.source);
      if (!profile) {
        metrics.unmatched_deposit_count += 1;
        metrics.last_unmatched_signature = transfer.signature;
        await appendCalLog(
          'watcher.log',
          JSON.stringify({
            level: 'info',
            ts: nowIso(),
            type: 'unmatched_deposit',
            signature: transfer.signature,
            source: transfer.source,
            destination: transfer.destination,
            lamports: transfer.lamports,
          }),
        );
        continue;
      }

      const amountSol = transfer.lamports / LAMPORTS_PER_SOL;
      const updated = await markWalletFunded(profile.wallet, amountSol);
      await appendRuntimeDepositEvent({
        wallet: updated.wallet,
        amount: amountSol,
        signature: transfer.signature,
      });
      metrics.attributed_deposit_count += 1;
      metrics.last_attributed_signature = transfer.signature;
      await appendCalLog(
        'watcher.log',
        JSON.stringify({
          level: 'info',
          ts: nowIso(),
          type: 'attributed_deposit',
          signature: transfer.signature,
          wallet: updated.wallet,
          credited_amount: updated.credited_amount,
          delta: amountSol,
          status: updated.status,
        }),
      );
    }
  }

  const newest = signatures[0]?.signature || state.last_seen_signature;
  await saveCalWatcherState({
    last_seen_signature: newest || null,
    updated_at: nowIso(),
  });
}

async function startWatcher(): Promise<void> {
  await ensureCalEnvironment();
  const metrics = await loadCalWatcherMetrics();
  if (!metrics.started_at) {
    metrics.started_at = nowIso();
  }
  await appendCalLog(
    'watcher.log',
    JSON.stringify({
      level: 'info',
      ts: nowIso(),
      type: 'watcher_started',
      treasury: CAL_TREASURY_ADDRESS,
      rpc: CAL_SOLANA_RPC_URL,
      interval_ms: POLL_INTERVAL_MS,
    }),
  );
  metrics.updated_at = nowIso();
  await saveCalWatcherMetrics(metrics);

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    metrics.poll_count += 1;
    metrics.last_poll_at = nowIso();
    try {
      await pollTreasuryOnce(metrics);
      metrics.last_success_at = nowIso();
      metrics.last_error = null;
    } catch (error) {
      metrics.error_count += 1;
      metrics.last_error = error instanceof Error ? error.message : String(error);
      await appendCalLog(
        'watcher.log',
        JSON.stringify({
          level: 'error',
          ts: nowIso(),
          type: 'poll_error',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      metrics.updated_at = nowIso();
      await saveCalWatcherMetrics(metrics);
      inFlight = false;
    }
  };

  await tick();
  setInterval(() => {
    void tick();
  }, Math.max(5000, POLL_INTERVAL_MS));
}

void startWatcher();
