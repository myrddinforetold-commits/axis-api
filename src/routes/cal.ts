import { Request, Response, Router } from 'express';
import { chatWithCal, CAL_TREASURY_ADDRESS } from '../lib/cal-runtime';
import { synthesizeCalSpeech } from '../lib/cal-tts';
import {
  CAL_CLASSIFICATION,
  CAL_IDENTITY,
  CAL_PATHS,
  ensureCalEnvironment,
  getOperatorProfile,
  loadCalWatcherMetrics,
  loadCalWatcherState,
  isValidWallet,
  registerOperatorWallet,
  bindWalletToSession,
  sanitizeSessionId,
} from '../lib/cal-storage';

export const calRouter = Router();

calRouter.get('/health', async (_req: Request, res: Response) => {
  try {
    await ensureCalEnvironment();
    const [metrics, state] = await Promise.all([
      loadCalWatcherMetrics(),
      loadCalWatcherState(),
    ]);
    const pollIntervalMs = Number(process.env.CAL_TREASURY_POLL_INTERVAL_MS || 30000);
    const now = Date.now();
    const lastPollAgeMs = metrics.last_poll_at ? Math.max(0, now - Date.parse(metrics.last_poll_at)) : null;
    const watcherHealthy = lastPollAgeMs !== null && Number.isFinite(lastPollAgeMs)
      ? lastPollAgeMs <= pollIntervalMs * 4
      : false;

    return res.json({
      ok: true,
      agent: 'cal9000',
      identity: CAL_IDENTITY,
      classification: CAL_CLASSIFICATION,
      treasury_address: CAL_TREASURY_ADDRESS,
      paths: {
        root: CAL_PATHS.root,
        soul: CAL_PATHS.soul,
        memory: CAL_PATHS.memory,
      },
      watcher: {
        healthy: watcherHealthy,
        poll_interval_ms: pollIntervalMs,
        last_poll_at: metrics.last_poll_at,
        last_state_update_at: state.updated_at,
      },
    });
  } catch (error) {
    console.error('CAL health error:', error);
    return res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed health check',
      code: 'INTERNAL_ERROR',
    });
  }
});

calRouter.get('/metrics', async (_req: Request, res: Response) => {
  try {
    await ensureCalEnvironment();
    const [metrics, state] = await Promise.all([
      loadCalWatcherMetrics(),
      loadCalWatcherState(),
    ]);
    return res.json({
      watcher: {
        ...metrics,
        last_seen_signature: state.last_seen_signature,
        state_updated_at: state.updated_at,
      },
    });
  } catch (error) {
    console.error('CAL metrics error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to load metrics',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /api/cal/tts
 * Body: { text, voice_id? }
 * Response: audio/mpeg
 */
calRouter.post('/tts', async (req: Request, res: Response) => {
  const { text, voice_id } = req.body as {
    text?: string;
    voice_id?: string;
  };

  if (!text || typeof text !== 'string') {
    return res.status(400).json({
      error: 'text is required',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const tts = await synthesizeCalSpeech({
      text,
      voiceId: typeof voice_id === 'string' ? voice_id : undefined,
    });

    res.setHeader('Content-Type', tts.mimeType);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-CAL-TTS-Provider', tts.provider);
    return res.status(200).send(tts.audio);
  } catch (error) {
    console.error('CAL tts error:', error);
    return res.status(502).json({
      error: error instanceof Error ? error.message : 'Failed to synthesize speech',
      code: 'TTS_FAILED',
    });
  }
});

/**
 * POST /api/cal/chat
 * Body: { session_id, message }
 * Response: { reply }
 */
calRouter.post('/chat', async (req: Request, res: Response) => {
  const { session_id, message } = req.body as {
    session_id?: string;
    message?: string;
  };

  if (!session_id || !message) {
    return res.status(400).json({
      error: 'session_id and message are required',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const result = await chatWithCal({
      sessionId: sanitizeSessionId(session_id),
      message,
    });
    return res.json({ reply: result.reply });
  } catch (error) {
    console.error('CAL chat error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to process CAL chat',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * POST /api/cal/register
 * Body: { wallet, session_id? }
 */
calRouter.post('/register', async (req: Request, res: Response) => {
  const { wallet, session_id } = req.body as {
    wallet?: string;
    session_id?: string;
  };

  if (!wallet) {
    return res.status(400).json({
      error: 'wallet is required',
      code: 'INVALID_REQUEST',
    });
  }

  if (!isValidWallet(wallet)) {
    return res.status(400).json({
      error: 'wallet format is invalid',
      code: 'INVALID_WALLET',
    });
  }

  try {
    const profile = await registerOperatorWallet(wallet);
    if (session_id) {
      await bindWalletToSession(sanitizeSessionId(session_id), wallet.trim());
    }
    return res.json({
      wallet: profile.wallet,
      status: profile.status,
      credited_amount: profile.credited_amount,
      treasury_address: CAL_TREASURY_ADDRESS,
    });
  } catch (error) {
    console.error('CAL register error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to register wallet',
      code: 'INTERNAL_ERROR',
    });
  }
});

/**
 * GET /api/cal/status?wallet=
 */
calRouter.get('/status', async (req: Request, res: Response) => {
  const wallet = String(req.query.wallet || '').trim();
  if (!wallet) {
    return res.status(400).json({
      error: 'wallet query param is required',
      code: 'INVALID_REQUEST',
    });
  }

  if (!isValidWallet(wallet)) {
    return res.status(400).json({
      error: 'wallet format is invalid',
      code: 'INVALID_WALLET',
    });
  }

  try {
    const profile = await getOperatorProfile(wallet);
    if (!profile) {
      return res.json({
        wallet,
        status: 'unregistered',
        credited_amount: 0,
        treasury_address: CAL_TREASURY_ADDRESS,
      });
    }

    return res.json({
      wallet: profile.wallet,
      status: profile.status,
      credited_amount: profile.credited_amount,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
      treasury_address: CAL_TREASURY_ADDRESS,
    });
  } catch (error) {
    console.error('CAL status error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to load wallet status',
      code: 'INTERNAL_ERROR',
    });
  }
});
