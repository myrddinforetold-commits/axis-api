import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { chatRouter } from './routes/chat';
import { statusRouter } from './routes/status';
import { autonomousRouter } from './routes/autonomous';
import { taskRouter } from './routes/task';
import { syncRouter } from './routes/sync';
import { memoryRouter } from './routes/memory';
import { provisionRouter } from './routes/provision';
import { workspaceRouter } from './routes/workspace';
import { calRouter } from './routes/cal.routes';
import { authMiddleware } from './middleware/auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3100;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'axis-moltbot-api', version: '0.1.0' });
});

// API routes (with auth)
app.use('/api/v1', authMiddleware);
app.use('/api/v1/chat', chatRouter);
app.use('/api/v1/status', statusRouter);
app.use('/api/v1/autonomous', autonomousRouter);
app.use('/api/v1/task', taskRouter);
app.use('/api/v1/sync', syncRouter);
app.use('/api/v1/memory', memoryRouter);
app.use('/api/v1/provision', provisionRouter);
app.use('/api/v1/workspace', workspaceRouter);
app.use('/api/cal', authMiddleware, calRouter);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error', 
    code: 'INTERNAL_ERROR' 
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not found', 
    code: 'NOT_FOUND' 
  });
});

app.listen(PORT, () => {
  console.log(`Axis Moltbot API running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

export default app;
