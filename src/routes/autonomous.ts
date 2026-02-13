import { Router, Request, Response } from 'express';
import { getAgentId, getSessionKey } from '../lib/moltbot-client';

export const autonomousRouter = Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Build the autonomous decision prompt from context
 */
function buildAutonomousPrompt(context: any): string {
  const { role, company, objectives = [], grounding, recentMemory = [], pendingRequests = 0 } = context;

  const groundingSection = grounding ? `
## Company Grounding (Source of Truth)
Products: ${grounding.products?.map((p: any) => p.name).join(', ') || 'None defined'}
Entities: ${grounding.entities?.map((e: any) => `${e.name} (${e.type})`).join(', ') || 'None'}
Target Customer: ${grounding.intendedCustomer || 'Not defined'}
Constraints: ${grounding.constraints?.map((c: any) => `[${c.type}] ${c.description}`).join('; ') || 'None'}
` : 'No grounding data available.';

  const objectivesSection = objectives.length > 0
    ? objectives.map((o: any, i: number) => `${i + 1}. ${o.title}: ${o.description} [${o.status}]`).join('\n')
    : 'No active objectives. Consider proposing an initial objective based on your mandate.';

  const memorySection = recentMemory.length > 0
    ? recentMemory.slice(0, 5).map((m: any) => `- ${m.label || 'Note'}: ${m.content.slice(0, 200)}`).join('\n')
    : 'No recent memory.';

  return `You are ${role?.name || 'an AI role'}, an autonomous AI role at ${company?.name || 'a company'}.

## Your Mandate
${role?.mandate || 'No mandate defined.'}

${groundingSection}

## Current Objectives
${objectivesSection}

## Recent Memory
${memorySection}

## Pending Requests: ${pendingRequests}

---
## AUTONOMOUS LOOP INSTRUCTIONS

Analyze the context and decide your next action. You MUST respond with valid JSON only (no markdown):

{
  "action": "propose_task" | "propose_memo" | "wait" | "complete_objective",
  "reasoning": "Brief explanation of your decision",
  "details": {
    // For propose_task:
    "title": "Task title",
    "description": "What to accomplish",
    "completion_criteria": "How to know it's done"
    
    // For propose_memo:
    "to_role": "Role name to send to",
    "content": "Memo content"
    
    // For complete_objective:
    "objective_id": "UUID of completed objective",
    "summary": "What was accomplished"
    
    // For wait:
    "reason": "Why waiting is appropriate"
  }
}

## Rules:
- If pending requests > 0, action MUST be "wait"
- Be specific and actionable in proposals
- Base decisions on KNOWN FACTS from grounding only
- Do NOT propose tasks requiring external integrations (email, CRM, etc.)
- Valid tasks: research, documents, memos, analysis, recommendations

Respond with JSON only:`;
}

/**
 * POST /api/v1/autonomous
 * Trigger autonomous loop (Observe-Decide-Propose cycle)
 */
autonomousRouter.post('/', async (req: Request, res: Response) => {
  const { company_id, role_id, context } = req.body;

  if (!company_id || !role_id) {
    return res.status(400).json({
      error: 'company_id and role_id are required',
      code: 'INVALID_REQUEST'
    });
  }

  try {
    const agentId = getAgentId(company_id, role_id);
    console.log(`Autonomous loop for agent ${agentId}`);

    // Quick exit if pending requests
    if (context?.pendingRequests > 0) {
      return res.json({
        action: 'wait',
        reasoning: `Agent has ${context.pendingRequests} pending workflow request(s)`,
        memory_used: false,
        tools_used: []
      });
    }

    // Build the prompt
    const prompt = buildAutonomousPrompt(context);

    // Call Anthropic API directly
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic API error:', errorText);
      
      return res.json({
        action: 'wait',
        reasoning: 'AI processing temporarily unavailable. Waiting for next cycle.',
        memory_used: false,
        tools_used: [],
        _error: errorText
      });
    }

    const result = await response.json() as { content?: Array<{ text?: string }> };
    const content = result.content?.[0]?.text || '';

    // Parse the AI decision
    let decision;
    try {
      // Extract JSON from response (may have markdown wrapping)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        decision = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', content);
      return res.json({
        action: 'wait',
        reasoning: 'Failed to parse AI decision. Waiting for next cycle.',
        memory_used: true,
        tools_used: [],
        _raw: content.slice(0, 500)
      });
    }

    // Return the decision with metadata
    res.json({
      ...decision,
      memory_used: true,
      tools_used: [],
      _agent: agentId
    });

  } catch (error) {
    console.error('Autonomous loop error:', error);
    res.status(500).json({
      error: 'Failed to run autonomous loop',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});
