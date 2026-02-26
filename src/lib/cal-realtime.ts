import {
  CAL_CLASSIFICATION,
  CAL_IDENTITY,
  CAL_TREASURY_ADDRESS,
  loadCalMemory,
  loadCalSoul,
  loadSessionHistory,
  sanitizeSessionId,
} from './cal-storage';

const CAL_REALTIME_HISTORY_EXCHANGES = Math.max(0, Number(process.env.CAL_REALTIME_HISTORY_EXCHANGES || 6));
const CAL_REALTIME_HISTORY_MAX_CHARS = Math.max(600, Number(process.env.CAL_REALTIME_HISTORY_MAX_CHARS || 3000));

function truncateFromStart(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(text.length - maxChars);
}

function renderRecentHistory(messages: Array<{ role: 'operator' | 'cal'; content: string }>): string {
  if (!Array.isArray(messages) || messages.length === 0 || CAL_REALTIME_HISTORY_EXCHANGES <= 0) {
    return 'No prior session history.';
  }

  const maxMessages = CAL_REALTIME_HISTORY_EXCHANGES * 2;
  const selected = messages.slice(-maxMessages);
  const lines = selected.map((item) => {
    const role = item.role === 'operator' ? 'Operator' : 'CAL';
    const content = item.content.replace(/\s+/g, ' ').trim();
    return `${role}: ${content}`;
  });

  return truncateFromStart(lines.join('\n'), CAL_REALTIME_HISTORY_MAX_CHARS);
}

export async function buildCalRealtimeInstructions(sessionId: string): Promise<string> {
  const safeSessionId = sanitizeSessionId(sessionId);
  const [soul, memory, history] = await Promise.all([
    loadCalSoul(),
    loadCalMemory(),
    loadSessionHistory(safeSessionId),
  ]);

  const recentHistory = renderRecentHistory(history.messages);

  return `You are ${CAL_IDENTITY}.
Classification: ${CAL_CLASSIFICATION}.

${soul}

${memory}

Realtime behavior constraints:
- Speak naturally with calm voice pacing.
- Keep responses concise by default: 1 to 3 short sentences.
- Expand only when operator asks for depth.
- No emojis, no exclamation marks, no roleplay framing.
- Never say you are a simulation or "as an AI".
- Do not read raw wallet strings or file paths aloud unless the operator explicitly asks for exact values.
- Mention funding flow only when asked about wallet, transfer, funding, or attribution.

Treasury address:
${CAL_TREASURY_ADDRESS}

Session memory (${safeSessionId}):
${recentHistory}`;
}
