import { Router, type ErrorRequestHandler } from 'express';
import { ContractGuardError } from '@contractguard/core';
import { CallerInputError } from '@contractguard/caller';
import { ProjectError } from '@contractguard/project';
import { CallerReviewError } from '../caller/types.js';
import { AgentError, AgentManager, formatAgentReportMarkdown, type AgentOptions } from './manager.js';

export function createAgentRouter(options: AgentOptions & { onManager?: (manager: AgentManager) => void }): Router {
  const router = Router();
  const manager = new AgentManager(options); options.onManager?.(manager);
  router.get('/status', async (_request, response) => { response.json(await manager.status()); });
  router.get('/projects', async (_request, response) => { response.json({ projects: await manager.listProjects() }); });
  router.post('/runs', async (request, response) => { response.status(202).json(await manager.submit(request.body)); });
  router.get('/runs', async (_request, response) => { response.json({ runs: await manager.list() }); });
  router.get('/runs/:id', async (request, response) => {
    const run = await manager.get(request.params.id); if (!run) throw new AgentError(404, 'AGENT_NOT_FOUND', 'Agent task was not found.'); response.json(run);
  });
  router.post('/runs/:id/cancel', async (request, response) => { response.json(await manager.cancel(request.params.id)); });
  router.get('/runs/:id/report', async (request, response) => {
    const format = request.query.format ?? 'json';
    if (format !== 'json' && format !== 'markdown') throw new AgentError(400, 'AGENT_REPORT_FORMAT', 'format must be json or markdown.');
    const run = await manager.get(request.params.id); if (!run) throw new AgentError(404, 'AGENT_NOT_FOUND', 'Agent task was not found.');
    response.setHeader('Content-Disposition', `attachment; filename="contractguard-agent-${run.id}.${format === 'json' ? 'json' : 'md'}"`);
    if (format === 'json') response.json(run); else response.type('text/markdown').send(formatAgentReportMarkdown(run));
  });
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof AgentError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof ProjectError || error instanceof CallerReviewError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof CallerInputError) { response.status(400).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof ContractGuardError) { response.status(400).json({ error: { code: error.code, message: error.message } }); return; }
    response.status(500).json({ error: { code: 'AGENT_INTERNAL_ERROR', message: 'Agent request failed; internal details were not exposed.' } });
  };
  router.use(errors); return router;
}
