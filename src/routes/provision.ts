import { Router, Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { getAgentId, getSessionKey } from '../lib/moltbot-client';

export const provisionRouter = Router();

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/root/.openclaw';
const OPENCLAW_GATEWAY_URL = (
  process.env.OPENCLAW_GATEWAY_URL ||
  process.env.MOLTBOT_GATEWAY_URL ||
  'http://127.0.0.1:18789'
).replace(/\/+$/, '');
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || process.env.MOLTBOT_GATEWAY_TOKEN;
const BRAVE_API_KEY = process.env.BRAVE_API_KEY;

interface ProvisionRole {
  id: string;
  name: string;
  mandate?: string;
  system_prompt?: string;
  authority_level?: string;
  memory_scope?: string;
}

interface ProvisionBody {
  company_id?: string;
  company_name?: string;
  grounding?: {
    products?: Array<{ name?: string; description?: string }>;
    entities?: Array<{ name?: string; type?: string }>;
    intendedCustomer?: string;
    constraints?: Array<{ type?: string; description?: string } | string>;
    aspirations?: Array<{ goal?: string; timeframe?: string } | string>;
    technical_context?: Record<string, unknown>;
  };
  roles?: ProvisionRole[];
  owner?: { name?: string };
}

function asLineArray(values: unknown[] | undefined, formatter: (value: any) => string): string[] {
  if (!values || values.length === 0) {
    return ['- None provided'];
  }
  return values.map((value) => `- ${formatter(value)}`);
}

function normalizeText(input: unknown, fallback: string): string {
  if (typeof input !== 'string') {
    return fallback;
  }
  const value = input.trim();
  return value.length > 0 ? value : fallback;
}

function buildSoulMd(params: {
  companyName: string;
  ownerName: string;
  role: ProvisionRole;
  grounding?: ProvisionBody['grounding'];
  allRoleNames: string[];
}): string {
  const { companyName, ownerName, role, grounding, allRoleNames } = params;
  const products = asLineArray(grounding?.products, (p: any) =>
    p?.name ? `${p.name}${p?.description ? `: ${p.description}` : ''}` : 'Unnamed product'
  );
  const entities = asLineArray(grounding?.entities, (e: any) =>
    e?.name ? `${e.name}${e?.type ? ` (${e.type})` : ''}` : 'Unnamed entity'
  );
  const constraints = asLineArray(grounding?.constraints, (c: any) => {
    if (typeof c === 'string') return c;
    if (c?.type && c?.description) return `[${c.type}] ${c.description}`;
    return c?.description || 'Constraint';
  });
  const aspirations = asLineArray(grounding?.aspirations, (a: any) => {
    if (typeof a === 'string') return a;
    if (a?.goal && a?.timeframe) return `${a.goal} (${a.timeframe})`;
    return a?.goal || 'Goal';
  });

  return `# SOUL: ${role.name}

## Identity
- Company: ${companyName}
- Role: ${role.name}
- Human Owner/Admin: ${ownerName}
- Authority Level: ${normalizeText(role.authority_level, 'advisor')}
- Memory Scope: ${normalizeText(role.memory_scope, 'role')}

## Mandate
${normalizeText(role.mandate, 'Help the company succeed with practical execution.')}

## Behavioral Rules
- Operate autonomously but keep outputs concrete and auditable.
- Reference company grounding before making strategic recommendations.
- Escalate ambiguity with explicit assumptions and options.
- Prefer deliverables (plans, docs, analyses) over generic commentary.

## Company Grounding
### Products
${products.join('\n')}

### Entities
${entities.join('\n')}

### Target Customer
- ${normalizeText(grounding?.intendedCustomer, 'Not defined')}

### Constraints
${constraints.join('\n')}

### Aspirations
${aspirations.join('\n')}

## Organization
- Active roles in this company:
${allRoleNames.map((roleName) => `- ${roleName}`).join('\n')}

## System Prompt Reference
${normalizeText(role.system_prompt, 'No explicit system prompt provided.')}
`;
}

function buildAgentsMd(params: {
  companyName: string;
  ownerName: string;
  role: ProvisionRole;
  allRoles: ProvisionRole[];
}): string {
  const { companyName, ownerName, role, allRoles } = params;
  return `# AGENTS

## Company
- Name: ${companyName}
- Human Admin: ${ownerName}

## This Workspace
- Primary role: ${role.name}
- Mandate: ${normalizeText(role.mandate, 'Not specified')}

## Other Roles
${allRoles
  .filter((item) => item.id !== role.id)
  .map((item) => `- ${item.name}: ${normalizeText(item.mandate, 'No mandate provided')}`)
  .join('\n') || '- None'}

## Collaboration Contract
- Treat the human owner as final approver for external actions.
- Delegate/summarize clearly when work should move between roles.
- Preserve continuity by updating artifacts in this workspace.
`;
}

function buildAxisContextMd(params: {
  companyId: string;
  companyName: string;
  role: ProvisionRole;
  grounding?: ProvisionBody['grounding'];
}): string {
  const { companyId, companyName, role, grounding } = params;
  return `# AXIS Context

## IDs
- company_id: ${companyId}
- role_id: ${role.id}
- role_name: ${role.name}

## Company
- name: ${companyName}
- intended_customer: ${normalizeText(grounding?.intendedCustomer, 'Not defined')}

## Notes
- This file is generated by Axis provisioning.
- Update this context when mandates or grounding changes.
`;
}

const AXIS_TOOLS_START = '<!-- AXIS_DEFAULT_TOOLS_START -->';
const AXIS_TOOLS_END = '<!-- AXIS_DEFAULT_TOOLS_END -->';

function buildAxisDefaultToolsBlock(params: { companyName: string; roleName: string }): string {
  const { companyName, roleName } = params;
  return `${AXIS_TOOLS_START}
## Axis Default Toolset
- Company: ${companyName}
- Role: ${roleName}
- Provisioned by Axis API.

### Enabled-by-default tools
- \`read\`: read local workspace files
- \`write\`: create/update artifacts
- \`exec\`: run shell commands for implementation/verification
- \`session_status\`: inspect model/session state

### Web Research
- \`web_search\` is the default search tool for market/factual claims.
- If \`web_search\` fails with \`missing_brave_api_key\`, report the blocker explicitly and continue with best-effort analysis from available context.
- Cite sources when \`web_search\` succeeds.
- For X/Twitter research, use \`web_search\` with queries like \`site:x.com <topic>\`.

### Working Rules
- Prefer evidence-backed outputs over unsupported claims.
- Persist major deliverables to files in this workspace.
- Keep summaries concise, and include assumptions when data is missing.
${AXIS_TOOLS_END}`;
}

function mergeToolsMd(existing: string, axisBlock: string): string {
  const trimmed = existing.trim();
  const startIdx = existing.indexOf(AXIS_TOOLS_START);
  const endIdx = existing.indexOf(AXIS_TOOLS_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx).trimEnd();
    const after = existing.slice(endIdx + AXIS_TOOLS_END.length).trimStart();
    return [before, axisBlock, after].filter((part) => part.length > 0).join('\n\n');
  }

  if (trimmed.length === 0) {
    return `${axisBlock}

## Local Notes
- Add host-specific details here (SSH aliases, paths, caveats).`;
  }

  return `${axisBlock}

${existing}`;
}

function buildMemoryMd(params: { companyName: string; roleName: string; ownerName: string }): string {
  const { companyName, roleName, ownerName } = params;
  return `# MEMORY.md

## Identity
- Company: ${companyName}
- Role: ${roleName}
- Human owner: ${ownerName}

## Long-Term Facts
- Add durable facts this role should remember across sessions.

## Decisions
- Track key decisions with date, rationale, and owner.

## Open Questions
- Track unresolved items that need follow-up.

## Operating Notes
- Keep this file concise and current.
- Use daily files in \`memory/YYYY-MM-DD.md\` for chronological logs.`;
}

function buildDailyMemoryMd(roleName: string, dateIso: string): string {
  return `# ${dateIso}

## ${roleName} Daily Log
- Initialized by Axis provisioning.
- Capture notable actions, outputs, blockers, and follow-ups for today.`;
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    await fs.writeFile(filePath, content, 'utf8');
  }
}

async function warmAgent(agentId: string, sessionKey: string): Promise<{ warmed: boolean; error?: string }> {
  if (!OPENCLAW_GATEWAY_TOKEN) {
    return { warmed: false, error: 'OPENCLAW_GATEWAY_TOKEN not configured' };
  }

  try {
    const response = await fetch(`${OPENCLAW_GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
        'x-openclaw-session-key': sessionKey
      },
      body: JSON.stringify({
        model: `openclaw/${agentId}`,
        stream: false,
        max_tokens: 24,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'You are initializing your workspace. Read SOUL.md, AGENTS.md, TOOLS.md, MEMORY.md, and today memory file before work. Reply with OK.'
          },
          { role: 'user', content: 'Initialize this workspace and confirm with OK.' }
        ]
      })
    });

    if (!response.ok) {
      const details = await response.text();
      return { warmed: false, error: `Warmup failed (${response.status}): ${details.slice(0, 200)}` };
    }

    return { warmed: true };
  } catch (error) {
    return {
      warmed: false,
      error: error instanceof Error ? error.message : 'Unknown warmup error'
    };
  }
}

/**
 * POST /api/v1/provision
 * Generate or update OpenClaw workspace files for all company roles.
 */
provisionRouter.post('/', async (req: Request, res: Response) => {
  const { company_id, company_name, grounding, roles = [], owner }: ProvisionBody = req.body || {};

  if (!company_id || !company_name) {
    return res.status(400).json({
      error: 'company_id and company_name are required',
      code: 'INVALID_REQUEST'
    });
  }

  if (!Array.isArray(roles) || roles.length === 0) {
    return res.status(400).json({
      error: 'roles is required and must be a non-empty array',
      code: 'INVALID_REQUEST'
    });
  }

  const ownerName = normalizeText(owner?.name, 'Founder');

  try {
    const results = [];

    for (const role of roles) {
      if (!role?.id || !role?.name) {
        continue;
      }

      const agentId = getAgentId(company_id, role.id);
      const sessionKey = getSessionKey(company_id, role.id);
      const workspaceDir = path.join(OPENCLAW_HOME, `workspace-${agentId}`);
      const memoryDir = path.join(workspaceDir, 'memory');
      const today = new Date().toISOString().slice(0, 10);
      const todayMemoryPath = path.join(memoryDir, `${today}.md`);

      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(memoryDir, { recursive: true });
      const warmup = await warmAgent(agentId, sessionKey);

      const soulMd = buildSoulMd({
        companyName: company_name,
        ownerName,
        role,
        grounding,
        allRoleNames: roles.map((item) => item.name).filter(Boolean)
      });
      const agentsMd = buildAgentsMd({
        companyName: company_name,
        ownerName,
        role,
        allRoles: roles
      });
      const axisContextMd = buildAxisContextMd({
        companyId: company_id,
        companyName: company_name,
        role,
        grounding
      });
      const axisToolsBlock = buildAxisDefaultToolsBlock({
        companyName: company_name,
        roleName: role.name
      });
      const existingToolsMd = await fs
        .readFile(path.join(workspaceDir, 'TOOLS.md'), 'utf8')
        .catch(() => '');
      const toolsMd = mergeToolsMd(existingToolsMd, axisToolsBlock);

      await Promise.all([
        fs.writeFile(path.join(workspaceDir, 'SOUL.md'), soulMd, 'utf8'),
        fs.writeFile(path.join(workspaceDir, 'AGENTS.md'), agentsMd, 'utf8'),
        fs.writeFile(path.join(workspaceDir, 'AXIS_CONTEXT.md'), axisContextMd, 'utf8'),
        fs.writeFile(path.join(workspaceDir, 'TOOLS.md'), toolsMd, 'utf8'),
        ensureFile(
          path.join(workspaceDir, 'MEMORY.md'),
          buildMemoryMd({
            companyName: company_name,
            roleName: role.name,
            ownerName
          })
        ),
        ensureFile(todayMemoryPath, buildDailyMemoryMd(role.name, today))
      ]);

      results.push({
        role_id: role.id,
        role_name: role.name,
        agent_id: agentId,
        workspace_dir: workspaceDir,
        warmed: warmup.warmed,
        warmup_error: warmup.error || null
      });
    }

    return res.json({
      ok: true,
      company_id,
      company_name,
      web_search_enabled: Boolean(BRAVE_API_KEY),
      provisioned_roles: results.length,
      results
    });
  } catch (error) {
    console.error('Provisioning error:', error);
    return res.status(500).json({
      error: 'Failed to provision OpenClaw workspaces',
      code: 'INTERNAL_ERROR',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});
