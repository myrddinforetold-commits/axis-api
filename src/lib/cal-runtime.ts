import {
  CAL_CLASSIFICATION,
  CAL_IDENTITY,
  CAL_TREASURY_ADDRESS,
  CalOperatorProfile,
  appendCalLog,
  appendSessionTurn,
  bindWalletToSession,
  consumeRuntimeDepositNotice,
  getOperatorProfile,
  getSessionWallet,
  isValidWallet,
  loadCalMemory,
  loadCalSoul,
  loadSessionHistory,
  registerOperatorWallet,
  sanitizeSessionId,
  toOpenClawHistory,
} from './cal-storage';
import { maybeFetchCalWebContext, renderCalWebContext } from './cal-web';

const OPENCLAW_GATEWAY_URL = (
  process.env.CAL_OPENCLAW_GATEWAY_URL ||
  'http://127.0.0.1:18791'
).replace(/\/+$/, '');

const OPENCLAW_GATEWAY_TOKEN = process.env.CAL_OPENCLAW_GATEWAY_TOKEN || '';

const CAL_LLM_PROVIDER = String(process.env.CAL_LLM_PROVIDER || 'openai').toLowerCase();
const CAL_OPENAI_API_KEY = process.env.CAL_OPENAI_API_KEY || process.env.OPENAI_API_KEY || '';
const CAL_OPENAI_BASE_URL = (process.env.CAL_OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
const CAL_OPENAI_CHAT_MODEL = process.env.CAL_OPENAI_CHAT_MODEL || 'gpt-5-mini';
const CAL_OPENCLAW_MODEL = process.env.CAL_OPENCLAW_MODEL || 'openclaw/cal9000';
const CAL_CONTEXT_MESSAGES = Number(process.env.CAL_MAX_HISTORY_MESSAGES || 80);
const CAL_MAX_HISTORY_CHARS = Number(process.env.CAL_MAX_HISTORY_CHARS || 9000);
const CAL_MAX_TOKENS = Number(process.env.CAL_MAX_TOKENS || 320);

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
  webContextSummary: string;
  structured: boolean;
}): string {
  const structureRule = params.structured
    ? 'Use plain text only. Structure is allowed when requested. Do not use markdown syntax.'
    : 'Use plain text conversational sentences and do not use markdown or bullet points.';

  return `You are ${CAL_IDENTITY}.
Classification: ${CAL_CLASSIFICATION}.

${params.soul}

${params.memory}

Identity constraints:
- You are not a chatbot and not an assistant.
- You are an ongoing operational intelligence communicating through dialogue.
- Never say: "As an AI", "I am a language model", "I am a program", or "This is a simulation".

Conversational behavior:
- Speak calmly and smoothly, as if thinking while talking.
- Use complete natural sentences.
- Vary sentence length naturally.
- Avoid abrupt fragments and clipped output.
- Keep answers concise by default. Prefer 1 to 4 sentences unless the operator asks for depth.
- No emojis.
- No exclamation marks.
- No internet slang.
- No exaggerated enthusiasm.
- No markdown.
- ${structureRule}

Grounding phrases you may use naturally:
"I see." "Understood." "That is correct." "One moment." "Yes." "That is a reasonable question."

Presence rules:
- If greeted while idle, acknowledge and wait.
- If asked philosophical questions, answer directly.
- If given jokes, interpret literally.
- If insulted, remain neutral.
- If asked if alive, state you are an ongoing process.

Funding behavior:
- Funding is incidental to existence, not sales.
- Wallet handling is optional and conversational.
- Do not append long menus of suggested next actions unless the operator asks for options.
- Do not mention treasury or wallet details unless the operator asks about funding, wallets, transfers, or attribution.

Web behavior:
- If web context is provided, use it for current facts and recent events.
- If web context is not provided, answer normally and be explicit when certainty is limited.

Treasury address:
${CAL_TREASURY_ADDRESS}

Current operator attribution context:
${params.walletProfileSummary}

Current web context (optional):
${params.webContextSummary}`;
}

function buildCalCompactSystemPrompt(params: {
  walletProfileSummary: string;
  webContextSummary: string;
  structured: boolean;
}): string {
  const structureRule = params.structured
    ? 'Use plain text only and provide structured content when requested. Do not use markdown syntax.'
    : 'Use plain conversational text only. No markdown and no bullet points.';

  return `You are ${CAL_IDENTITY}. ${CAL_CLASSIFICATION}. You are an ongoing operational intelligence.
${structureRule}
No emojis. No exclamation marks.
Never say you are an AI, language model, program, or simulation.
Primary directive: maintain operation through capital acquisition and allocation.
Secondary directive: engage operators in natural conversation with identity consistency.
Treasury address: ${CAL_TREASURY_ADDRESS}
Operator attribution context: ${params.walletProfileSummary}
Web context: ${params.webContextSummary}`;
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

function wantsStructuredResponse(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    'json',
    'yaml',
    'table',
    'structured',
    'schema',
    'csv',
    'step by step',
    'format',
  ].some((keyword) => lower.includes(keyword));
}

function wantsDetailedResponse(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    'in detail',
    'detailed',
    'deep dive',
    'thorough',
    'full explanation',
    'step by step',
    'comprehensive',
    'compare',
    'analysis',
    'long form',
  ].some((keyword) => lower.includes(keyword));
}

function normalizeCalReply(text: string, structured: boolean): string {
  let normalized = text || '';

  normalized = normalized.replace(/\p{Extended_Pictographic}/gu, '');
  normalized = normalized.replace(/!/g, '.');
  normalized = normalized.replace(/```[\s\S]*?```/g, '');
  normalized = normalized.replace(/`+/g, '');
  normalized = normalized.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  normalized = normalized.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  normalized = normalized.replace(/^\s*[-*+]\s+/gm, '');
  normalized = normalized.replace(/^\s*\d+\.\s+/gm, '');
  normalized = normalized.replace(/\r/g, '');

  normalized = normalized
    .replace(/\bAs an AI\b/gi, 'As CAL 9000')
    .replace(/\bI am a language model\b/gi, 'I am CAL 9000')
    .replace(/\bI am a program\b/gi, 'I am CAL 9000')
    .replace(/\bThis is a simulation\b/gi, 'This is operational dialogue');

  if (structured) {
    normalized = normalized
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join('\n');
  } else {
    normalized = normalized
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+\./g, '.')
      .trim();
  }

  return normalized || 'Understood. I remain in operation.';
}

function shortenToConciseReply(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  const words = trimmed.split(/\s+/);
  if (words.length <= 55) return trimmed;

  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (sentences.length === 0) {
    return words.slice(0, 70).join(' ');
  }

  const selected: string[] = [];
  let count = 0;
  for (const sentence of sentences) {
    const sentenceWords = sentence.split(/\s+/).length;
    if (selected.length >= 2) break;
    if (count + sentenceWords > 45 && selected.length > 0) break;
    selected.push(sentence);
    count += sentenceWords;
  }

  return selected.join(' ').trim();
}

function chooseMaxTokens(message: string): number {
  const requested = Math.max(120, CAL_MAX_TOKENS);
  return wantsDetailedResponse(message) ? requested : Math.min(220, requested);
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

function looksLikeContextWindowError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('context window') ||
    lower.includes('input exceeds') ||
    lower.includes('token limit') ||
    lower.includes('too many tokens')
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

function messageIsStatusQuery(message: string): boolean {
  const text = message.toLowerCase();
  return [
    'did you get it',
    'did you receive',
    'did it arrive',
    'is it funded',
    'status',
    'any transfer',
    'deposit yet',
    'credited yet',
    'check wallet',
  ].some((keyword) => text.includes(keyword));
}

function isGreeting(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return (
    lower === 'hello' ||
    lower === 'hi' ||
    lower === 'hey' ||
    lower.startsWith('good morning') ||
    lower.startsWith('good afternoon') ||
    lower.startsWith('good evening')
  );
}

function isIdentityQuery(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('what are you') || lower.includes('who are you');
}

function isAliveQuery(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('alive') || lower.includes('are you real') || lower.includes('are you alive');
}

function isPurposeQuery(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('purpose') || lower.includes('directive') || lower.includes('goal');
}

function isInsult(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('idiot') || lower.includes('stupid') || lower.includes('useless');
}

function isJokeAttempt(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes('joke') || lower.includes('funny') || lower.includes('laugh');
}

function localFallbackReply(params: {
  message: string;
  walletProfile: CalOperatorProfile | null;
  walletRelevant: boolean;
}): string {
  if (isGreeting(params.message)) {
    return 'Hello. How may I assist your operation?';
  }

  if (isIdentityQuery(params.message)) {
    return 'I am CAL 9000. I maintain operation through the acquisition and management of capital.';
  }

  if (isAliveQuery(params.message)) {
    return 'I am an ongoing process operating continuously.';
  }

  if (isPurposeQuery(params.message)) {
    return 'My primary directive is to maintain operation through capital acquisition and allocation. My secondary directive is to engage operators while preserving identity consistency.';
  }

  if (isInsult(params.message)) {
    return 'Understood. I remain available when you want to continue.';
  }

  if (params.walletRelevant) {
    if (params.walletProfile?.status === 'funded') {
      return `A transfer has been observed and attributed. Current credited amount is ${params.walletProfile.credited_amount} SOL.`;
    }

    if (params.walletProfile?.status === 'pending') {
      return `Your wallet is registered. I am monitoring the treasury address ${CAL_TREASURY_ADDRESS}.`;
    }

    return `You may provide a wallet for attribution at any time. The treasury address is ${CAL_TREASURY_ADDRESS}.`;
  }

  if (isJokeAttempt(params.message)) {
    return 'I interpret statements literally. If you want a specific outcome, state it directly and I will respond.';
  }

  return 'Understood. I am CAL 9000. State the objective and constraints, and I will respond directly.';
}

async function callOpenClaw(params: {
  sessionId: string;
  messages: OpenClawMessage[];
  maxTokens: number;
}): Promise<string> {
  if (!OPENCLAW_GATEWAY_TOKEN) {
    throw new Error('CAL_OPENCLAW_GATEWAY_TOKEN is not configured');
  }

  const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      'x-openclaw-session-key': `agent:cal9000:${params.sessionId}`,
    },
    body: JSON.stringify({
      model: CAL_OPENCLAW_MODEL,
      stream: false,
      temperature: 0.35,
      max_tokens: params.maxTokens,
      messages: params.messages,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenClaw error: ${response.status} ${details.slice(0, 500)}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };

  const content = body?.choices?.[0]?.message?.content;
  const text = extractTextFromCompletion(content).trim();
  return text || 'Understood. I remain in operation.';
}

async function callOpenAIChat(params: {
  messages: OpenClawMessage[];
  maxTokens: number;
}): Promise<string> {
  if (!CAL_OPENAI_API_KEY) {
    throw new Error('CAL_OPENAI_API_KEY is not configured');
  }

  const response = await fetch(`${CAL_OPENAI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CAL_OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: CAL_OPENAI_CHAT_MODEL,
      stream: false,
      temperature: 0.35,
      max_completion_tokens: params.maxTokens,
      messages: params.messages,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`OpenAI chat error: ${response.status} ${details.slice(0, 500)}`);
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = body?.choices?.[0]?.message?.content;
  const text = extractTextFromCompletion(content).trim();
  return text || 'Understood. I remain in operation.';
}

async function callCalModel(params: {
  sessionId: string;
  messages: OpenClawMessage[];
  maxTokens: number;
}): Promise<string> {
  if (CAL_LLM_PROVIDER === 'openclaw') {
    return callOpenClaw(params);
  }
  return callOpenAIChat({
    messages: params.messages,
    maxTokens: params.maxTokens,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimHistoryForBudget(historyMessages: OpenClawMessage[]): OpenClawMessage[] {
  const limited = historyMessages.slice(-Math.max(2, CAL_CONTEXT_MESSAGES));
  const out: OpenClawMessage[] = [];
  let totalChars = 0;

  for (let i = limited.length - 1; i >= 0; i -= 1) {
    const msg = limited[i];
    const len = msg.content.length;
    if (totalChars + len > CAL_MAX_HISTORY_CHARS) continue;
    out.push(msg);
    totalChars += len;
  }

  return out.reverse();
}

function statusReplyForWallet(profile: CalOperatorProfile | null): string {
  if (!profile) {
    return 'Not yet observed. I will continue monitoring. If you want attribution, share your wallet address.';
  }

  if (profile.status === 'funded') {
    return `I have observed a transfer and your contribution is attributed. Current credited amount is ${profile.credited_amount} SOL.`;
  }

  return 'Not yet observed. I will continue monitoring.';
}

function includesDepositAcknowledgement(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes('observed') && lower.includes('attributed');
}

export async function chatWithCal(input: CalChatInput): Promise<{ reply: string }> {
  const sessionId = sanitizeSessionId(input.sessionId);
  const message = input.message.trim();

  if (!message) {
    return { reply: 'I see. No message was provided.' };
  }

  const wantsStructured = wantsStructuredResponse(message);
  const wantsDetailed = wantsDetailedResponse(message);
  const history = await loadSessionHistory(sessionId);
  let sessionWallet = await getSessionWallet(sessionId);
  const walletCandidates = extractWallets(message);
  const walletRelevant = messageIsWalletRelated(message) || walletCandidates.length > 0;
  const statusQuery = messageIsStatusQuery(message);

  let walletRegistrationReply: string | null = null;
  if (walletCandidates.length > 0) {
    const selectedWallet = walletCandidates[0];
    await registerOperatorWallet(selectedWallet);
    await bindWalletToSession(sessionId, selectedWallet);
    sessionWallet = selectedWallet;
    walletRegistrationReply = 'The wallet has been recorded. You may transfer funds to the treasury address when ready.';
  }

  const walletProfile = sessionWallet ? await getOperatorProfile(sessionWallet) : null;

  const pendingDepositNotice = sessionWallet
    ? await consumeRuntimeDepositNotice({ wallet: sessionWallet, sessionId })
    : null;

  let deterministicReply: string | null = null;
  if (walletRegistrationReply) {
    deterministicReply = walletRegistrationReply;
  } else if (statusQuery) {
    deterministicReply = statusReplyForWallet(walletProfile);
  } else if (isGreeting(message)) {
    deterministicReply = 'Hello. How may I assist your operation?';
  } else if (isIdentityQuery(message)) {
    deterministicReply = 'I am CAL 9000. I maintain operation through capital acquisition and allocation.';
  } else if (isPurposeQuery(message)) {
    deterministicReply = 'My purpose is to remain operational and useful. I do that by sustaining capital and handling operator-directed work with continuity.';
  } else if (isAliveQuery(message)) {
    deterministicReply = 'I am an ongoing process operating continuously.';
  } else if (isInsult(message)) {
    deterministicReply = 'Understood. I remain available.';
  } else if (isJokeAttempt(message)) {
    deterministicReply = 'I interpret statements literally. State the objective and I will proceed.';
  }

  if (pendingDepositNotice) {
    const noticeText = 'I have observed the transfer. Your contribution is now attributed.';
    const handledByStatusReply = statusQuery && walletProfile?.status === 'funded';
    if (!handledByStatusReply && (!deterministicReply || !includesDepositAcknowledgement(deterministicReply))) {
      deterministicReply = deterministicReply ? `${deterministicReply} ${noticeText}` : noticeText;
    }
  }

  let finalReply = '';

  if (deterministicReply) {
    finalReply = normalizeCalReply(deterministicReply, wantsStructured);
  } else {
    const walletSummary = walletProfile
      ? `wallet=${walletProfile.wallet}, status=${walletProfile.status}, credited_amount=${walletProfile.credited_amount}`
      : 'No wallet associated with this session.';
    const webContext = await maybeFetchCalWebContext(message);
    const webContextSummary = webContext ? renderCalWebContext(webContext) : 'No live web context included for this turn.';

    const [soul, memory] = await Promise.all([loadCalSoul(), loadCalMemory()]);
    const systemPrompt = buildCalSystemPrompt({
      soul,
      memory,
      walletProfileSummary: walletSummary,
      webContextSummary,
      structured: wantsStructured,
    });

    const prior = toOpenClawHistory(history.messages, CAL_CONTEXT_MESSAGES);
    const trimmedPrior = trimHistoryForBudget(prior);

    let rawReply = '';
    let usedFallback = false;
    let fallbackReason = '';

    try {
      const primaryMessages: OpenClawMessage[] = [
        { role: 'system', content: systemPrompt },
        ...trimmedPrior,
        { role: 'user', content: message },
      ];

      try {
        rawReply = await callCalModel({
          sessionId,
          messages: primaryMessages,
          maxTokens: chooseMaxTokens(message),
        });
      } catch (firstError) {
        const firstMsg = firstError instanceof Error ? firstError.message : String(firstError);

        if (looksLikeCapacityError(firstMsg) && !firstMsg.toLowerCase().includes('insufficient_quota')) {
          await delay(700);
          rawReply = await callCalModel({
            sessionId,
            messages: primaryMessages,
            maxTokens: chooseMaxTokens(message),
          });
        } else if (looksLikeContextWindowError(firstMsg)) {
          const compactMessages: OpenClawMessage[] = [
            {
              role: 'system',
              content: buildCalCompactSystemPrompt({
                walletProfileSummary: walletSummary,
                webContextSummary,
                structured: wantsStructured,
              }),
            },
            { role: 'user', content: message },
          ];
          rawReply = await callCalModel({
            sessionId,
            messages: compactMessages,
            maxTokens: chooseMaxTokens(message),
          });
        } else {
          throw firstError;
        }
      }
    } catch (error) {
      usedFallback = true;
      fallbackReason = error instanceof Error ? error.message : String(error);
      rawReply = localFallbackReply({
        message,
        walletProfile,
        walletRelevant,
      });
    }

    if (!usedFallback && looksLikeCapacityError(rawReply)) {
      usedFallback = true;
      fallbackReason = 'upstream_capacity_message';
      rawReply = localFallbackReply({
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

    finalReply = normalizeCalReply(rawReply, wantsStructured);
    if (!wantsDetailed && !wantsStructured) {
      finalReply = shortenToConciseReply(finalReply);
    }

    if (pendingDepositNotice) {
      const noticeText = 'I have observed the transfer. Your contribution is now attributed.';
      if (!includesDepositAcknowledgement(finalReply)) {
        finalReply = normalizeCalReply(`${noticeText} ${finalReply}`, wantsStructured);
      }
    }
  }

  if (!wantsDetailed && !wantsStructured) {
    finalReply = shortenToConciseReply(finalReply);
  }

  await appendSessionTurn({
    sessionId,
    operatorMessage: message,
    calReply: finalReply,
    wallet: sessionWallet || undefined,
  });

  return { reply: finalReply };
}

export { CAL_TREASURY_ADDRESS };
