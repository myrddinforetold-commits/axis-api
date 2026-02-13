import { Router, Request, Response } from 'express';
import { getAgentId } from '../lib/moltbot-client';

export const chatRouter = Router();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Build chat prompt with role context
 */
function buildChatPrompt(role: any, company: any, grounding: any, objectives: any[]): string {
  const groundingSection = grounding ? `
## Company Grounding (Source of Truth)
Products: ${grounding.products?.map((p: any) => p.name).join(', ') || 'None defined'}
Entities: ${grounding.entities?.map((e: any) => `${e.name} (${e.type})`).join(', ') || 'None'}
Target Customer: ${grounding.intendedCustomer || 'Not defined'}
Constraints: ${grounding.constraints?.map((c: any) => `[${c.type}] ${c.description}`).join('; ') || 'None'}
` : '';

  const objectivesSection = objectives && objectives.length > 0
    ? `## Current Objectives\n${objectives.map((o: any, i: number) => `${i + 1}. ${o.title}: ${o.description} [${o.status}]`).join('\n')}`
    : '';

  return `You are ${role?.name || 'an AI executive'}, an autonomous AI role at ${company?.name || 'a company'}.

## Your Mandate
${role?.mandate || 'Help the company succeed.'}

${groundingSection}

${objectivesSection}

## Communication Style
- Be direct and actionable
- Reference specific grounding data when relevant
- If you don't know something, say so
- Propose concrete next steps when appropriate

Respond naturally to the user's message.`;
}

/**
 * POST /api/v1/chat
 * Send a message to a role agent and get streaming response
 */
chatRouter.post('/', async (req: Request, res: Response) => {
  const { company_id, role_id, message, context } = req.body;

  if (!company_id || !role_id || !message) {
    return res.status(400).json({
      error: 'company_id, role_id, and message are required',
      code: 'INVALID_REQUEST'
    });
  }

  try {
    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const agentId = getAgentId(company_id, role_id);
    console.log(`Chat request for agent ${agentId}: ${message.slice(0, 100)}...`);

    // Send initial status
    res.write(`event: status\ndata: ${JSON.stringify({ status: 'thinking' })}\n\n`);

    // Build system prompt with context
    const systemPrompt = buildChatPrompt(
      context?.role,
      context?.company,
      context?.grounding,
      context?.objectives || []
    );

    // Call Anthropic API with streaming
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        stream: true,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: message
          }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Anthropic API error:', errorText);
      res.write(`event: error\ndata: ${JSON.stringify({ 
        error: 'AI processing failed',
        code: 'AI_ERROR'
      })}\n\n`);
      res.end();
      return;
    }

    // Stream the response
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              const text = parsed.delta.text;
              fullContent += text;
              res.write(`event: delta\ndata: ${JSON.stringify({ content: text })}\n\n`);
            }
            
            if (parsed.type === 'message_delta' && parsed.usage) {
              outputTokens = parsed.usage.output_tokens || 0;
            }
            
            if (parsed.type === 'message_start' && parsed.message?.usage) {
              inputTokens = parsed.message.usage.input_tokens || 0;
            }
          } catch (e) {
            // Skip non-JSON lines
          }
        }
      }
    }

    // Send done event
    res.write(`event: done\ndata: ${JSON.stringify({ 
      content: fullContent,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens }
    })}\n\n`);
    res.end();

    // Handle client disconnect
    req.on('close', () => {
      reader.cancel();
    });

  } catch (error) {
    console.error('Chat error:', error);
    
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ 
        error: error instanceof Error ? error.message : 'Failed to process chat',
        code: 'INTERNAL_ERROR'
      })}\n\n`);
      res.end();
    } else {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to process chat',
        code: 'INTERNAL_ERROR'
      });
    }
  }
});
