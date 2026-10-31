import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runPipeline, anonymizeLive, outputFiles } from './pipeline.js';
import { IdentityStore } from './identity.js';
import type { RecordCounts, RecordValue, SourceKind } from './types.js';

type Job = { status: 'queued' | 'running' | 'done' | 'failed'; started_at?: string; finished_at?: string; records?: RecordCounts; cost?: { tokens_in: number; tokens_out: number; seconds: number }; error?: string };
const root = resolve(process.env.DATA_DIR ?? '.');
const outputDir = join(root, 'output'); const dbFile = join(root, 'identities.sqlite');
const jobsFile = join(root, 'jobs.json');
const jobs = new Map<string, Job>();
let running = false;
let activeJobId: string | undefined;

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > 5_000_000) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
function validRecord(source: SourceKind, record: unknown): record is RecordValue {
  if (!record || typeof record !== 'object') return false;
  const r = record as Record<string, unknown>;
  if (typeof r.id !== 'string') return false;
  const stringMap = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string');
  if (source === 'chats') return ['thread_id', 'author', 'ts', 'text'].every(k => typeof r[k] === 'string') && Array.isArray(r.attachments) && r.attachments.every(item => !!item && typeof item === 'object' && typeof item.filename === 'string');
  if (source === 'docs') return ['pdf', 'html', 'md'].includes(String(r.format)) && ['filename', 'title', 'body'].every(k => typeof r[k] === 'string') && stringMap(r.metadata);
  return ['clientes', 'transacciones', 'pqrs', 'empleados'].includes(String(r.table)) && stringMap(r.columns);
}
function safeError(error: unknown): string { return error instanceof Error ? error.message.replace(/Bearer\s+\S+/gi, 'Bearer [hidden]') : 'Unexpected error'; }
function persistJobs(): void {
  const temporary = `${jobsFile}.next`;
  writeFileSync(temporary, JSON.stringify([...jobs]), { mode: 0o600 });
  renameSync(temporary, jobsFile);
}

await mkdir(root, { recursive: true });
if (existsSync(jobsFile)) {
  try {
    for (const [id, saved] of JSON.parse(readFileSync(jobsFile, 'utf8')) as [string, Job][]) {
      if (saved.status === 'queued' || saved.status === 'running') { saved.status = 'failed'; saved.finished_at = new Date().toISOString(); saved.error = 'Interrupted by service restart'; }
      jobs.set(id, saved);
    }
    persistJobs();
  } catch { /* A damaged job history does not prevent the service from starting. */ }
}
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/v1/health') return send(res, 200, { status: 'ok', team: process.env.TEAM_NAME ?? 'Kipu Pay', version: '0.1.0', models: [] });
    if (req.method === 'POST' && pathname === '/v1/run') {
      const data = await body(req) as Record<string, unknown>;
      if (typeof data?.sources_url !== 'string' || typeof data?.token !== 'string') return send(res, 422, { error: 'sources_url and token required' });
      if (running && activeJobId) return send(res, 202, { job_id: activeJobId });
      const id = randomUUID(); const job: Job = { status: 'queued' }; jobs.set(id, job); running = true; activeJobId = id; persistJobs();
      const sourcesUrl = data.sources_url; const token = data.token;
      setImmediate(async () => {
        const started = Date.now(); job.status = 'running'; job.started_at = new Date(started).toISOString(); persistJobs();
        try { job.records = await runPipeline(sourcesUrl, token, outputDir, dbFile); job.status = 'done'; }
        catch (error) { job.status = 'failed'; job.error = safeError(error); }
        finally { job.finished_at = new Date().toISOString(); job.cost = { tokens_in: 0, tokens_out: 0, seconds: (Date.now() - started) / 1000 }; running = false; activeJobId = undefined; persistJobs(); }
      });
      return send(res, 202, { job_id: id });
    }
    const jobMatch = pathname.match(/^\/v1\/run\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) { const job = jobs.get(jobMatch[1]); return job ? send(res, 200, job) : send(res, 404, { error: 'Job not found' }); }
    const fileMatch = pathname.match(/^\/v1\/output\/([^/]+)$/);
    if (req.method === 'GET' && fileMatch) {
      if (!outputFiles.has(fileMatch[1])) return send(res, 404, { error: 'File not found' });
      try { const content = await readFile(join(outputDir, fileMatch[1])); res.writeHead(200, { 'Content-Type': fileMatch[1].endsWith('.jsonl') ? 'application/x-ndjson; charset=utf-8' : 'application/json; charset=utf-8' }); return res.end(content); }
      catch { return send(res, 404, { error: 'No completed output' }); }
    }
    if (req.method === 'POST' && pathname === '/v1/anonymize') {
      const data = await body(req) as Record<string, unknown>;
      if (!['chats', 'docs', 'tables'].includes(String(data?.source)) || !Array.isArray(data?.records) || data.records.length > 50) return send(res, 422, { error: 'Invalid source or records' });
      const source = data.source as SourceKind;
      if (!data.records.every(r => validRecord(source, r))) return send(res, 422, { error: 'Record outside schema' });
      return send(res, 200, anonymizeLive(source, data.records as RecordValue[], dbFile));
    }
    if (req.method === 'GET' && pathname === '/v1/entities') {
      try { return send(res, 200, JSON.parse(await readFile(join(outputDir, 'entities.json'), 'utf8'))); }
      catch { const store = new IdentityStore(dbFile); try { return send(res, 200, { entities: store.entities() }); } finally { store.close(); } }
    }
    return send(res, 404, { error: 'Not found' });
  } catch (error) { return send(res, error instanceof SyntaxError ? 422 : error instanceof Error && error.message === 'Request too large' ? 413 : 500, { error: safeError(error) }); }
});
server.listen(Number(process.env.PORT ?? 9000), '0.0.0.0');
