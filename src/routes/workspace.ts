import { Router, Request, Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { getAgentId } from '../lib/moltbot-client';

export const workspaceRouter = Router();

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/root/.openclaw';
const MAX_FILE_BYTES = Number(process.env.WORKSPACE_FILE_MAX_BYTES || 1_000_000);
const ALLOWED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.csv']);

function sanitizeRelativePath(input: unknown): string | null {
  const value = String(input || '').trim();
  if (!value) return null;

  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalized.includes('\0')) return null;

  const cleaned = path.posix.normalize(normalized);
  if (!cleaned || cleaned === '.' || cleaned.startsWith('..') || path.posix.isAbsolute(cleaned)) {
    return null;
  }

  return cleaned;
}

function resolveWorkspaceFilePath(workspaceDir: string, relativePath: string): string | null {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const absolutePath = path.resolve(resolvedWorkspace, relativePath);

  if (absolutePath === resolvedWorkspace) return null;
  if (!absolutePath.startsWith(`${resolvedWorkspace}${path.sep}`)) return null;
  return absolutePath;
}

function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md') return 'text/markdown';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.json') return 'application/json';
  if (ext === '.yml' || ext === '.yaml') return 'application/yaml';
  if (ext === '.csv') return 'text/csv';
  return 'application/octet-stream';
}

/**
 * POST /api/v1/workspace/read
 * Read a safe, relative file path from a role's OpenClaw workspace.
 */
workspaceRouter.post('/read', async (req: Request, res: Response) => {
  const { company_id, role_id, file_path } = req.body as {
    company_id?: string;
    role_id?: string;
    file_path?: string;
  };

  if (!company_id || !role_id || !file_path) {
    return res.status(400).json({
      error: 'company_id, role_id, and file_path are required',
      code: 'INVALID_REQUEST',
    });
  }

  const relativePath = sanitizeRelativePath(file_path);
  if (!relativePath) {
    return res.status(400).json({
      error: 'Invalid file_path',
      code: 'INVALID_PATH',
    });
  }

  const extension = path.extname(relativePath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return res.status(400).json({
      error: `Unsupported file extension: ${extension || '(none)'}`,
      code: 'UNSUPPORTED_FILE_TYPE',
    });
  }

  try {
    const agentId = getAgentId(company_id, role_id);
    const workspaceDir = path.join(OPENCLAW_HOME, `workspace-${agentId}`);
    const absolutePath = resolveWorkspaceFilePath(workspaceDir, relativePath);

    if (!absolutePath) {
      return res.status(400).json({
        error: 'Invalid resolved path',
        code: 'INVALID_PATH',
      });
    }

    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return res.status(404).json({
        error: 'File not found',
        code: 'NOT_FOUND',
      });
    }

    if (stat.size > MAX_FILE_BYTES) {
      return res.status(413).json({
        error: `File too large (${stat.size} bytes)`,
        code: 'FILE_TOO_LARGE',
      });
    }

    const content = await fs.readFile(absolutePath, 'utf8');
    return res.json({
      ok: true,
      file: {
        file_path: relativePath,
        filename: path.basename(relativePath),
        size_bytes: stat.size,
        mime_type: inferMimeType(relativePath),
        content,
      },
    });
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return res.status(404).json({
        error: 'File not found',
        code: 'NOT_FOUND',
      });
    }

    console.error('Workspace read error:', error);
    return res.status(500).json({
      error: 'Failed to read workspace file',
      code: 'INTERNAL_ERROR',
    });
  }
});
