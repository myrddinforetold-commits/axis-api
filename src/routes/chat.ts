import { Router, Request, Response } from 'express';
import { sendMessage, getAgentId } from '../lib/moltbot-client';

export const chatRouter = Router();

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

    // Call Moltbot gateway
    const stream = await sendMessage(company_id, role_id, message, context);
    
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        // Send done event
        res.write(`event: done\ndata: ${JSON.stringify({ 
          content: fullContent,
          usage: { input_tokens: 0, output_tokens: 0 }
        })}\n\n`);
        res.end();
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      fullContent += chunk;
      
      // Forward chunk as delta event
      res.write(`event: delta\ndata: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    // Handle client disconnect
    req.on('close', () => {
      reader.cancel();
    });

  } catch (error) {
    console.error('Chat error:', error);
    
    // If headers already sent, send error via SSE
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
