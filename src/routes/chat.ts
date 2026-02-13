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
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Send initial status
    res.write(`event: status\ndata: ${JSON.stringify({ status: 'thinking' })}\n\n`);

    // TODO: Integrate with actual Moltbot gateway streaming
    // For now, simulate a response to test the flow
    
    const agentId = getAgentId(company_id, role_id);
    console.log(`Chat request for agent ${agentId}: ${message.slice(0, 100)}...`);

    // Simulate tool usage (will be real events from Moltbot)
    setTimeout(() => {
      res.write(`event: tool_start\ndata: ${JSON.stringify({ 
        tool: 'memory_search', 
        query: 'relevant context' 
      })}\n\n`);
    }, 500);

    setTimeout(() => {
      res.write(`event: tool_end\ndata: ${JSON.stringify({ 
        tool: 'memory_search', 
        result_summary: 'Found 2 relevant entries' 
      })}\n\n`);
    }, 1000);

    setTimeout(() => {
      res.write(`event: memory_ref\ndata: ${JSON.stringify({ 
        source: 'MEMORY.md', 
        lines: [5, 8], 
        snippet: 'Previous discussion about priorities...' 
      })}\n\n`);
    }, 1200);

    // Simulate streaming response
    const response = `I've reviewed the context and your message. Based on our previous discussions, here's my analysis...

This is a placeholder response. Once the Moltbot integration is complete, you'll receive actual AI-generated responses with real tool usage and memory references.

The system is working - the SSE stream is properly configured.`;

    const words = response.split(' ');
    let wordIndex = 0;

    const streamInterval = setInterval(() => {
      if (wordIndex >= words.length) {
        clearInterval(streamInterval);
        
        // Send done event
        res.write(`event: done\ndata: ${JSON.stringify({ 
          content: response,
          usage: { input_tokens: 150, output_tokens: 50 }
        })}\n\n`);
        
        res.end();
        return;
      }

      const chunk = words[wordIndex] + ' ';
      res.write(`event: delta\ndata: ${JSON.stringify({ content: chunk })}\n\n`);
      wordIndex++;
    }, 50);

    // Handle client disconnect
    req.on('close', () => {
      clearInterval(streamInterval);
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.write(`event: error\ndata: ${JSON.stringify({ 
      error: 'Failed to process chat',
      code: 'INTERNAL_ERROR'
    })}\n\n`);
    res.end();
  }
});
