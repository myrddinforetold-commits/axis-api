import { Router, Request, Response } from 'express';
import { getAgentMemory, updateAgentMemory, getAgentId } from '../lib/moltbot-client';

export const memoryRouter = Router();

/**
 * GET /api/v1/memory
 * Get agent's long-term memory
 */
memoryRouter.get('/', async (req: Request, res: Response) => {
  const { company_id, role_id } = req.query;

  if (!company_id || !role_id) {
    return res.status(400).json({
      error: 'company_id and role_id are required',
      code: 'INVALID_REQUEST'
    });
  }

  try {
    const memory = await getAgentMemory(
      company_id as string,
      role_id as string
    );

    if (!memory) {
      return res.json({
        content: '# Agent Memory\n\nNo memory recorded yet.',
        format: 'markdown',
        last_updated: null,
        size_bytes: 0
      });
    }

    res.json({
      content: memory.content,
      format: 'markdown',
      last_updated: memory.lastUpdated.toISOString(),
      size_bytes: Buffer.byteLength(memory.content, 'utf8')
    });

  } catch (error) {
    console.error('Memory fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch agent memory',
      code: 'INTERNAL_ERROR'
    });
  }
});

/**
 * PUT /api/v1/memory
 * Update agent's long-term memory
 */
memoryRouter.put('/', async (req: Request, res: Response) => {
  const { company_id, role_id, content, mode = 'replace' } = req.body;

  if (!company_id || !role_id || !content) {
    return res.status(400).json({
      error: 'company_id, role_id, and content are required',
      code: 'INVALID_REQUEST'
    });
  }

  try {
    const success = await updateAgentMemory(
      company_id,
      role_id,
      content
    );

    if (!success) {
      return res.status(500).json({
        error: 'Failed to update memory',
        code: 'INTERNAL_ERROR'
      });
    }

    res.json({
      ok: true,
      size_bytes: Buffer.byteLength(content, 'utf8')
    });

  } catch (error) {
    console.error('Memory update error:', error);
    res.status(500).json({
      error: 'Failed to update agent memory',
      code: 'INTERNAL_ERROR'
    });
  }
});
