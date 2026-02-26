import { Request, Response, Router } from 'express';
import { chatWithCal, CAL_TREASURY_ADDRESS } from '../lib/cal-runtime';
import { synthesizeCalSpeech } from '../lib/cal-tts';
import { buildCalRealtimeInstructions } from '../lib/cal-realtime';
import {
  CAL_CLASSIFICATION,
  CAL_IDENTITY,
  CAL_PATHS,
  appendSessionTurn,
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
const OPENAI_API_KEY = process.env.CAL_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
const CAL_OPENAI_REALTIME_MODEL = process.env.CAL_OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview';
const CAL_OPENAI_REALTIME_VOICE = process.env.CAL_OPENAI_REALTIME_VOICE || 'ash';
const CAL_OPENAI_REALTIME_TEMPERATURE = Number(process.env.CAL_OPENAI_REALTIME_TEMPERATURE || 0.6);
const CAL_OPENAI_REALTIME_MAX_OUTPUT_TOKENS = Math.max(
  120,
  Number(process.env.CAL_OPENAI_REALTIME_MAX_OUTPUT_TOKENS || 220),
);

function extractWalletsFromText(text: string): string[] {
  const matches = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  const deduped = new Set<string>();
  for (const wallet of matches) {
    if (isValidWallet(wallet)) deduped.add(wallet);
  }
  return [...deduped];
}

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
  const { session_id, message, include_audio, voice_id } = req.body as {
    session_id?: string;
    message?: string;
    include_audio?: boolean;
    voice_id?: string;
  };

  if (!session_id || !message) {
    return res.status(400).json({
      error: 'session_id and message are required',
      code: 'INVALID_REQUEST',
    });
  }

  try {
    const startedAt = Date.now();
    const result = await chatWithCal({
      sessionId: sanitizeSessionId(session_id),
      message,
    });

    const payload: Record<string, unknown> = {
      reply: result.reply,
      chat_latency_ms: Date.now() - startedAt,
    };

    if (include_audio === true) {
      const ttsStartedAt = Date.now();
      try {
        const tts = await synthesizeCalSpeech({
          text: result.reply,
          voiceId: typeof voice_id === 'string' ? voice_id : undefined,
        });
        payload.audio = {
          provider: tts.provider,
          mime_type: tts.mimeType,
          data_base64: tts.audio.toString('base64'),
          tts_latency_ms: Date.now() - ttsStartedAt,
        };
      } catch (ttsError) {
        payload.audio_error = ttsError instanceof Error ? ttsError.message : 'Failed to synthesize speech';
      }
    }

    return res.json(payload);
  } catch (error) {
    console.error('CAL chat error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to process CAL chat',
      code: 'INTERNAL_ERROR',
    });
  }
});

calRouter.get('/realtime/config', (_req: Request, res: Response) => {
  return res.json({
    provider: 'openai-realtime',
    model: CAL_OPENAI_REALTIME_MODEL,
    voice: CAL_OPENAI_REALTIME_VOICE,
    max_output_tokens: CAL_OPENAI_REALTIME_MAX_OUTPUT_TOKENS,
    temperature: CAL_OPENAI_REALTIME_TEMPERATURE,
    requires_server_token: true,
  });
});

calRouter.post('/realtime/session', async (req: Request, res: Response) => {
  const { session_id, model, voice } = req.body as {
    session_id?: string;
    model?: string;
    voice?: string;
  };

  const safeSessionId = sanitizeSessionId(session_id || `rt_${Date.now().toString(36)}`);
  const targetModel = String(model || CAL_OPENAI_REALTIME_MODEL).trim();
  const targetVoice = String(voice || CAL_OPENAI_REALTIME_VOICE).trim();

  if (!OPENAI_API_KEY) {
    return res.status(503).json({
      error: 'OpenAI key not configured for realtime sessions',
      code: 'REALTIME_NOT_CONFIGURED',
    });
  }

  try {
    const instructions = await buildCalRealtimeInstructions(safeSessionId);
    const openAiResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: targetModel,
        voice: targetVoice,
        modalities: ['audio', 'text'],
        instructions,
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 420,
        },
        temperature: CAL_OPENAI_REALTIME_TEMPERATURE,
        max_response_output_tokens: CAL_OPENAI_REALTIME_MAX_OUTPUT_TOKENS,
      }),
    });

    const bodyText = await openAiResponse.text();
    if (!openAiResponse.ok) {
      return res.status(502).json({
        error: 'Failed to create realtime session',
        code: 'REALTIME_SESSION_FAILED',
        details: bodyText.slice(0, 600),
      });
    }

    const realtimeSession = JSON.parse(bodyText) as Record<string, any>;
    return res.json({
      session_id: safeSessionId,
      provider: 'openai-realtime',
      model: targetModel,
      voice: targetVoice,
      client_secret: realtimeSession?.client_secret?.value || null,
      client_secret_expires_at: realtimeSession?.client_secret?.expires_at || null,
      realtime_session: realtimeSession,
    });
  } catch (error) {
    console.error('CAL realtime session error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to create realtime session',
      code: 'INTERNAL_ERROR',
    });
  }
});

calRouter.post('/realtime/commit', async (req: Request, res: Response) => {
  const { session_id, user_text, assistant_text, wallet } = req.body as {
    session_id?: string;
    user_text?: string;
    assistant_text?: string;
    wallet?: string;
  };

  if (!session_id) {
    return res.status(400).json({
      error: 'session_id is required',
      code: 'INVALID_REQUEST',
    });
  }

  const operatorMessage = String(user_text || '').trim();
  const calReply = String(assistant_text || '').trim();
  if (!operatorMessage || !calReply) {
    return res.status(400).json({
      error: 'user_text and assistant_text are required',
      code: 'INVALID_REQUEST',
    });
  }

  const safeSessionId = sanitizeSessionId(session_id);

  try {
    let boundWallet: string | null = null;
    const walletCandidates = [
      String(wallet || '').trim(),
      ...extractWalletsFromText(operatorMessage),
    ].filter(Boolean);

    for (const candidate of walletCandidates) {
      if (!isValidWallet(candidate)) continue;
      const profile = await registerOperatorWallet(candidate);
      await bindWalletToSession(safeSessionId, profile.wallet);
      boundWallet = profile.wallet;
      break;
    }

    await appendSessionTurn({
      sessionId: safeSessionId,
      operatorMessage,
      calReply,
      wallet: boundWallet || undefined,
    });

    return res.json({
      ok: true,
      session_id: safeSessionId,
      wallet: boundWallet,
    });
  } catch (error) {
    console.error('CAL realtime commit error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to persist realtime turn',
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
        status: 'pending',
        registered: false,
        credited_amount: 0,
        treasury_address: CAL_TREASURY_ADDRESS,
      });
    }

    return res.json({
      wallet: profile.wallet,
      status: profile.status,
      registered: true,
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
