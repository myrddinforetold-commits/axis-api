import { Router, Request, Response } from 'express';
import { getAgentId } from '../lib/moltbot-client';

export const syncRouter = Router();

/**
 * POST /api/v1/sync
 * Sync company context to Moltbot (grounding, memory, roles)
 */
syncRouter.post('/', async (req: Request, res: Response) => {
  const { company_id, grounding, company_memory, roles } = req.body;

  if (!company_id) {
    return res.status(400).json({
      error: 'company_id is required',
      code: 'INVALID_REQUEST'
    });
  }

  try {
    console.log(`Syncing context for company ${company_id}`);

    // TODO: Implement actual sync to Moltbot agent workspaces
    // This will:
    // 1. Update each agent's workspace with grounding data
    // 2. Update shared company memory files
    // 3. Ensure agent configs are up to date

    const synced = {
      grounding: !!grounding,
      memory_entries: company_memory?.length || 0,
      roles: roles?.length || 0
    };

    // For each role, we'd update their workspace
    if (roles) {
      for (const role of roles) {
        const agentId = getAgentId(company_id, role.id);
        console.log(`  - Would sync agent ${agentId}: ${role.name}`);
        
        // TODO: Write grounding to agent's workspace
        // TODO: Write role-specific config (mandate, etc.)
      }
    }

    res.json({
      ok: true,
      synced
    });

  } catch (error) {
    console.error('Sync error:', error);
    res.status(500).json({
      error: 'Failed to sync context',
      code: 'INTERNAL_ERROR'
    });
  }
});
