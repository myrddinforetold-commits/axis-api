/**
 * Moltbot Gateway Client
 * 
 * Communicates with the local Moltbot gateway to manage agent sessions.
 * Each company+role maps to a unique Moltbot agent/session.
 */

const GATEWAY_URL = process.env.MOLTBOT_GATEWAY_URL || 'http://localhost:18789';
const GATEWAY_TOKEN = process.env.MOLTBOT_GATEWAY_TOKEN;

export interface AgentSession {
  key: string;
  status: 'idle' | 'thinking' | 'executing';
  lastActive: Date;
  contextTokens: number;
  totalTokens: number;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: Date;
}

/**
 * Get the agent ID for a company+role combination
 */
export function getAgentId(companyId: string, roleId: string): string {
  // Format: axis_{companyId}_{roleId}
  // Truncate UUIDs for readability
  const companyShort = companyId.slice(0, 8);
  const roleShort = roleId.slice(0, 8);
  return `axis_${companyShort}_${roleShort}`;
}

/**
 * Get the session key for a company+role
 */
export function getSessionKey(companyId: string, roleId: string): string {
  const agentId = getAgentId(companyId, roleId);
  return `agent:${agentId}:main`;
}

/**
 * Send a message to an agent and get streaming response
 */
export async function sendMessage(
  companyId: string,
  roleId: string,
  message: string,
  context?: {
    grounding?: Record<string, unknown>;
    companyMemory?: Array<{ content: string; label?: string }>;
    objectives?: Array<{ id: string; title: string; status: string }>;
  }
): Promise<ReadableStream<Uint8Array>> {
  const sessionKey = getSessionKey(companyId, roleId);
  
  // Build context-enriched message
  let enrichedMessage = message;
  
  if (context) {
    const contextParts: string[] = [];
    
    if (context.grounding) {
      contextParts.push(`[Company Context: ${JSON.stringify(context.grounding)}]`);
    }
    
    if (context.objectives && context.objectives.length > 0) {
      const objList = context.objectives.map(o => `- ${o.title} (${o.status})`).join('\n');
      contextParts.push(`[Current Objectives:\n${objList}]`);
    }
    
    if (contextParts.length > 0) {
      enrichedMessage = `${contextParts.join('\n\n')}\n\n---\n\nUser message: ${message}`;
    }
  }

  // Call Moltbot gateway's session send endpoint
  const response = await fetch(`${GATEWAY_URL}/api/sessions/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(GATEWAY_TOKEN ? { 'Authorization': `Bearer ${GATEWAY_TOKEN}` } : {})
    },
    body: JSON.stringify({
      sessionKey,
      message: enrichedMessage,
      stream: true
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Moltbot gateway error: ${response.status} ${error}`);
  }

  return response.body as ReadableStream<Uint8Array>;
}

/**
 * Get agent session status
 */
export async function getSessionStatus(
  companyId: string,
  roleId: string
): Promise<AgentSession | null> {
  const sessionKey = getSessionKey(companyId, roleId);

  try {
    const response = await fetch(`${GATEWAY_URL}/api/sessions?key=${encodeURIComponent(sessionKey)}`, {
      headers: {
        ...(GATEWAY_TOKEN ? { 'Authorization': `Bearer ${GATEWAY_TOKEN}` } : {})
      }
    });

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new Error(`Moltbot gateway error: ${response.status}`);
    }

    const data = await response.json() as { updatedAt?: string; contextTokens?: number; totalTokens?: number };
    
    return {
      key: sessionKey,
      status: 'idle', // TODO: detect from session state
      lastActive: new Date(data.updatedAt || Date.now()),
      contextTokens: data.contextTokens || 0,
      totalTokens: data.totalTokens || 0
    };
  } catch (error) {
    console.error('Failed to get session status:', error);
    return null;
  }
}

/**
 * Get agent memory content
 */
export async function getAgentMemory(
  companyId: string,
  roleId: string
): Promise<{ content: string; lastUpdated: Date } | null> {
  const agentId = getAgentId(companyId, roleId);
  
  // Memory would be stored in the agent's workspace
  // For now, return placeholder - will implement with actual file access
  return {
    content: '# Agent Memory\n\nNo memory recorded yet.',
    lastUpdated: new Date()
  };
}

/**
 * Update agent memory content
 */
export async function updateAgentMemory(
  companyId: string,
  roleId: string,
  content: string
): Promise<boolean> {
  const agentId = getAgentId(companyId, roleId);
  
  // TODO: Write to agent's MEMORY.md file
  console.log(`Would update memory for agent ${agentId}`);
  return true;
}

/**
 * List all sessions for a company
 */
export async function listCompanySessions(companyId: string): Promise<AgentSession[]> {
  try {
    const response = await fetch(`${GATEWAY_URL}/api/sessions`, {
      headers: {
        ...(GATEWAY_TOKEN ? { 'Authorization': `Bearer ${GATEWAY_TOKEN}` } : {})
      }
    });

    if (!response.ok) {
      throw new Error(`Moltbot gateway error: ${response.status}`);
    }

    const data = await response.json() as { sessions?: Array<{ key: string; updatedAt?: string; contextTokens?: number; totalTokens?: number }> };
    const companyPrefix = `agent:axis_${companyId.slice(0, 8)}`;
    
    // Filter sessions for this company
    const sessions = (data.sessions || [])
      .filter((s: any) => s.key.startsWith(companyPrefix))
      .map((s: any) => ({
        key: s.key,
        status: 'idle' as const,
        lastActive: new Date(s.updatedAt || Date.now()),
        contextTokens: s.contextTokens || 0,
        totalTokens: s.totalTokens || 0
      }));

    return sessions;
  } catch (error) {
    console.error('Failed to list company sessions:', error);
    return [];
  }
}
