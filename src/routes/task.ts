import { Router, Request, Response } from 'express';
import { getAgentId } from '../lib/moltbot-client';

export const taskRouter = Router();

/**
 * POST /api/v1/task
 * Execute a task with streaming progress
 */
taskRouter.post('/', async (req: Request, res: Response) => {
  const { company_id, role_id, task } = req.body;

  if (!company_id || !role_id || !task) {
    return res.status(400).json({
      error: 'company_id, role_id, and task are required',
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
    console.log(`Task execution for agent ${agentId}: ${task.title}`);

    // Simulate task execution steps
    const steps = [
      { step: 1, total: 5, label: 'Understanding task requirements', delay: 500 },
      { step: 2, total: 5, label: 'Gathering relevant information', delay: 1000 },
      { step: 3, total: 5, label: 'Analyzing data', delay: 1500 },
      { step: 4, total: 5, label: 'Synthesizing findings', delay: 1000 },
      { step: 5, total: 5, label: 'Writing deliverable', delay: 1500 }
    ];

    // Send initial status
    res.write(`event: status\ndata: ${JSON.stringify({ 
      status: 'executing', 
      phase: 'understanding' 
    })}\n\n`);

    let currentStep = 0;
    
    const processStep = () => {
      if (currentStep >= steps.length) {
        // Task complete
        const output = `# ${task.title}

## Summary
Task completed successfully based on analysis of available information.

## Findings
This is a placeholder output. Once Moltbot integration is complete, 
you'll see actual AI-generated deliverables here.

## Completion Criteria
${task.completion_criteria}

✅ Criteria met`;

        res.write(`event: output\ndata: ${JSON.stringify({ chunk: output })}\n\n`);
        res.write(`event: done\ndata: ${JSON.stringify({ 
          output,
          success: true,
          evaluation: 'pass'
        })}\n\n`);
        res.end();
        return;
      }

      const step = steps[currentStep];
      
      // Mark previous step as done
      if (currentStep > 0) {
        const prevStep = steps[currentStep - 1];
        res.write(`event: progress\ndata: ${JSON.stringify({ 
          step: prevStep.step, 
          total: prevStep.total, 
          label: prevStep.label, 
          done: true 
        })}\n\n`);
      }

      // Start current step
      res.write(`event: progress\ndata: ${JSON.stringify({ 
        step: step.step, 
        total: step.total, 
        label: step.label, 
        done: false 
      })}\n\n`);

      // Simulate tool usage on step 2
      if (step.step === 2) {
        setTimeout(() => {
          res.write(`event: tool_start\ndata: ${JSON.stringify({ 
            tool: 'web_search', 
            query: task.title 
          })}\n\n`);
        }, step.delay / 2);

        setTimeout(() => {
          res.write(`event: tool_end\ndata: ${JSON.stringify({ 
            tool: 'web_search', 
            result_summary: 'Found relevant information' 
          })}\n\n`);
        }, step.delay);
      }

      currentStep++;
      setTimeout(processStep, step.delay);
    };

    processStep();

    // Handle client disconnect
    req.on('close', () => {
      console.log('Task stream closed by client');
    });

  } catch (error) {
    console.error('Task execution error:', error);
    res.write(`event: error\ndata: ${JSON.stringify({ 
      error: 'Failed to execute task',
      code: 'INTERNAL_ERROR'
    })}\n\n`);
    res.end();
  }
});
