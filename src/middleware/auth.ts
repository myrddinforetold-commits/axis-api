import { Request, Response, NextFunction } from 'express';

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: 'Missing or invalid authorization header',
      code: 'AUTH_FAILED'
    });
  }

  const token = authHeader.slice(7);
  const validToken = process.env.API_KEY;

  if (!validToken || token !== validToken) {
    return res.status(401).json({ 
      error: 'Invalid API key',
      code: 'AUTH_FAILED'
    });
  }

  next();
}
