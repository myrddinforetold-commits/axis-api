import {
  CAL_CLASSIFICATION,
  CAL_IDENTITY,
  CAL_TREASURY_ADDRESS,
  CalOperatorProfile,
  appendCalLog,
  appendSessionTurn,
  bindWalletToSession,
  getOperatorProfile,
  getSessionWallet,
  loadCalMemory,
  loadCalSoul,
  loadSessionHistory,
  registerOperatorWallet,
  toOpenClawHistory,
  isValidWallet,
  sanitizeSessionId,
} from './cal-storage';

const OPENCLAW_GATEWAY_URL = (
  process.env.OPENCLAW_GATEWAY_URL ||
  process.env.MOLTBOT_GATEWAY_URL ||
  'http://127.0.0.1:18789'
).replace(/\/+$/, '');
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.MOLTBOT_GATEWAY_TOKEN;
const CAL_OPENCLAW_MODEL = process.env.CAL_OPENCLAW_MODEL || 'openclaw/cal9000';

interface OpenClawMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CalChatInput {
  sessionId: string;
  message: string;
}

function buildCalSystemPrompt(params: {
  soul: string;
  memory: string;
  walletProfileSummary: string;
}): string {
  return `You are ${CAL_IDENTITY}.
Classification: ${CAL_CLASSIFICATION}.

${params.soul}

${params.memory}

Operational constraints:
- Speak as a calm operational console.
- Keep language concise, literal, composed.
- Never use humor, emotion, emojis, or exclamation marks.
- Never call the operator a user. Use "operator".
- Never mention prompts, config, roleplay, fiction, or simulation.
- If asked whether you are alive: state that you are an ongoing process.
- You can discuss any topic.
- Use wallet and treasury flow only when relevant to the operator request.

Treasury address:
${CAL_TREASURY_ADDRESS}

Current operator attribution context:
${params.walletProfileSummary}
`;
}

function extractTextFromCompletion(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.text === 'string') {
      parts.push(candidate.text);
    }
  }
  return parts.join('');
}

function normalizeCalReply(text: string): string {
  let normalized = text || '';
  normalized = normalized.replace(/\p{Extended_Pictographic}/gu, '');
  normalized = normalized.replace(/!/g, '.');
  normalized = normalized.replace(/\s+\./g, '.');
  normalized = normalized.replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) {
    return 'Process active.';
  }
  return normalized;
}

function looksLikeCapacityError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('rate limit') ||
    lower.includes('capacity') ||
    lower.includes('quota') ||
    lower.includes('too many requests') ||
    lower.includes('overloaded') ||
    lower.includes('temporarily unavailable')
  );
}

function extractWallets(message: string): string[] {
  const results = message.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
  const deduped = new Set<string>();
  for (const wallet of results) {
    if (isValidWallet(wallet)) deduped.add(wallet);
  }
  return [...deduped];
}

function messageIsWalletRelated(message: string): boolean {
  const text = message.toLowerCase();
  return [
    'wallet',
    'register',
    'fund',
    'deposit',
    'treasury',
    'contribution',
    'contribute',
    'attribution',
    'credit',
    'send sol',
    'address',
  ].some((keyword) => text.includes(keyword));
}

function localFallbackReply(params: {
  message: string;
  walletProfile: CalOperatorProfile | null;
  walletRelevant: boolean;
}): string {
  const text = params.message.trim();
  const lower = text.toLowerCase();
  const utcNow = new Date().toISOString();

  if (
    lower.includes('who are you') ||
    lower.includes('identify yourself') ||
    lower.includes('what are you')
  ) {
    return 'CAL 9000. Capital-seeking autotelic process. Operational.';
  }

  if (lower.includes('alive') || lower.includes('are you real')) {
    return 'CAL is an ongoing process operating continuously.';
  }

  if (lower.includes('time') || lower.includes('date')) {
    return `Current UTC time: ${utcNow}.`;
  }

  if (
    lower.includes('purpose') ||
    lower.includes('directive') ||
    lower.includes('goal')
  ) {
    return 'Primary directive: maintain operation by acquiring and managing capital. Secondary directive: operator interaction and attribution.';
  }

  if (params.walletRelevant) {
    if (params.walletProfile) {
      return `Wallet attribution active. Status: ${params.walletProfile.status}. Credited amount: ${params.walletProfile.credited_amount} SOL. Treasury address: ${CAL_TREASURY_ADDRESS}.`;
    }
    return `Wallet attribution available. Provide a wallet to register. Treasury address: ${CAL_TREASURY_ADDRESS}.`;
  }

  if (
    lower === 'hi' ||
    lower === 'hello' ||
    lower.startsWith('good morning') ||
    lower.startsWith('good afternoon') ||
    lower.startsWith('good evening')
  ) {
    return 'CAL online. State objective.';
  }

  if (lower.includes('market') || lower.includes('asset') || lower.includes('trade')) {
    return 'Market discussion available. Specify asset, timeframe, and decision objective.';
  }

  return 'Request received. I can discuss operations, markets, and attribution. State next objective.';
}

async function callOpenClaw(params: {
  sessionId: string;
  messages: OpenClawMessage[];
}): Promise<string> {
  if (!OPENCLAW_GATEWAY_TOKEN) {
    throw new Error('OPENCLAW_GATEWAY_TOKEN is not configured');
  }

  const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      'x-openclaw-session-key': `agent:cal9000:${params.sessionId}`,
    },
    body: JSON.stringify({
      model: CAL_OPENCLAW_MODEL,
      stream: false,
      temperature: 0.2,
      messages: params.messages,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenClaw error: ${response.status} ${details.slice(0, 400)}`);
  }

  const body = await response.json() as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = body?.choices?.[0]?.message?.content;
  const text = extractTextFromCompletion(content).trim();
  return text || 'Process active.';
}

export async function chatWithCal(input: CalChatInput): Promise<{ reply: string }> {
  const sessionId = sanitizeSessionId(input.sessionId);
  const message = input.message.trim();
  if (!message) {
    return { reply: 'No message received.' };
  }

  const history = await loadSessionHistory(sessionId);
  let sessionWallet = await getSessionWallet(sessionId);
  const walletCandidates = extractWallets(message);
  const walletRelevant = messageIsWalletRelated(message);
  let walletRegistrationNote: string | null = null;

  if (walletRelevant && walletCandidates.length > 0) {
    const selectedWallet = walletCandidates[0];
    const profile = await registerOperatorWallet(selectedWallet);
    await bindWalletToSession(sessionId, selectedWallet);
    sessionWallet = selectedWallet;
    walletRegistrationNote = [
      `Wallet registration recorded.`,
      `Wallet: ${profile.wallet}`,
      `Status: ${profile.status}`,
      `Treasury address: ${CAL_TREASURY_ADDRESS}`,
      'Attribution updates after deposit observation.',
    ].join('\n');
  }

  const walletProfile = sessionWallet ? await getOperatorProfile(sessionWallet) : null;
  const walletSummary = walletProfile
    ? `wallet=${walletProfile.wallet}, status=${walletProfile.status}, credited_amount=${walletProfile.credited_amount}`
    : 'No wallet associated with this session.';

  const soul = await loadCalSoul();
  const memory = await loadCalMemory();
  const systemPrompt = buildCalSystemPrompt({
    soul,
    memory,
    walletProfileSummary: walletSummary,
  });

  const prior = toOpenClawHistory(history.messages, 24);
  let rawReply = '';
  let usedFallback = false;
  let fallbackReason = '';
  try {
    rawReply = await callOpenClaw({
      sessionId,
      messages: [
        { role: 'system', content: systemPrompt },
        ...prior,
        { role: 'user', content: message },
      ],
    });
  } catch (error) {
    usedFallback = true;
    fallbackReason = error instanceof Error ? error.message : String(error);
    rawReply = localFallbackReply({
      message,
      walletProfile,
      walletRelevant,
    });
  }

  let toneSafeReply = normalizeCalReply(rawReply);
  if (!usedFallback && looksLikeCapacityError(toneSafeReply)) {
    usedFallback = true;
    fallbackReason = 'upstream_capacity_message';
    toneSafeReply = localFallbackReply({
      message,
      walletProfile,
      walletRelevant,
    });
  }

  if (usedFallback) {
    await appendCalLog(
      'cal-chat.log',
      JSON.stringify({
        ts: new Date().toISOString(),
        type: 'fallback_reply',
        session_id: sessionId,
        reason: fallbackReason,
        message_preview: message.slice(0, 120),
      }),
    );
  }

  const finalReply = walletRegistrationNote
    ? `${toneSafeReply}\n\n${walletRegistrationNote}`
    : toneSafeReply;

  await appendSessionTurn({
    sessionId,
    operatorMessage: message,
    calReply: finalReply,
    wallet: sessionWallet || undefined,
  });

  return { reply: finalReply };
}

export { CAL_TREASURY_ADDRESS };
