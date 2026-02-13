import { Router, Request, Response } from 'express';
import { getSessionStatus, getAgentId } from '../lib/moltbot-client';

export const statusRouter = Router();

/**
 * GET /api/v1/status
 * Get current agent status for polling
 */
statusRouter.get('/', async (req: Request, res: Response) => {
  const { company_id, role_id } = req.query;

  if (!company_id || !role_id) {
    return res.status(400).json({
      error: 'company_id and role_id are required',
      code: 'INVALID_REQUEST'
    });
  }

  try {
    const session = await getSessionStatus(
      company_id as string,
      role_id as string
    );

    if (!session) {
      // Agent not provisioned yet - return default idle state
      return res.json({
        status: 'idle',
        last_active: null,
        session: {
          tokens_used: 0,
          context_size: 0,
          context_limit: 200000
        },
        memory: {
          entries: 0,
          last_updated: null
        },
        pending_workflow: false
      });
    }

    res.json({
      status: session.status,
      last_active: session.lastActive.toISOString(),
      session: {
        tokens_used: session.totalTokens,
        context_size: session.contextTokens,
        context_limit: 200000
      },
      memory: {
        entries: 0, // TODO: count from MEMORY.md
        last_updated: null
      },
      pending_workflow: false // TODO: check from Supabase
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({
      error: 'Failed to get agent status',
      code: 'INTERNAL_ERROR'
    });
  }
});
