import { XMLParser } from 'fast-xml-parser';
import { PDFParse } from 'pdf-parse';
import type { ChatRecord, DocRecord, TableRecord, RecordCounts } from './types.js';

type SourceUser = { id: string; name?: string; username?: string; real_name?: string; is_bot?: boolean; profile?: { real_name?: string; display_name?: string; email?: string; title?: string } };
type SourceMessage = { user: string; text: string; ts: string; thread_ts?: string; client_msg_id: string; subtype?: string; files?: { name?: string; title?: string }[] };
type SourceChannel = { id: string; name?: string };
type DocIndex = { id: string; filename: string; format: 'pdf' | 'html' | 'md' };
type TableIndex = { name: string; format: string; charset?: string; separator?: string };
export type Ingested = { chats: ChatRecord[]; docs: DocRecord[]; tables: TableRecord[]; users: SourceUser[]; uidByChat: Map<string, string>; index: Record<keyof RecordCounts, string[]> };

export class SourceClient {
  private previous = 0;
  constructor(private readonly base: string, private readonly token: string) {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid sources_url');
  }
  private async get(path: string): Promise<Response> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const delay = Math.max(0, 110 - (Date.now() - this.previous));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      this.previous = Date.now();
      const response = await fetch(`${this.base.replace(/\/$/, '')}${path}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(30_000) });
      if (response.ok) return response;
      if (![429, 502, 503, 504].includes(response.status) || attempt === 3) throw new Error(`Source request failed (${response.status}) at ${path}`);
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
    }
    throw new Error(`Source request failed at ${path}`);
  }
  async json<T>(path: string): Promise<T> { return this.get(path).then(r => r.json() as Promise<T>); }
  async bytes(path: string): Promise<Uint8Array> { return this.get(path).then(async r => new Uint8Array(await r.arrayBuffer())); }
}

function parseCsv(input: string, separator: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') { if (quoted && input[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && char === separator) { row.push(field); field = ''; }
    else if (!quoted && (char === '\n' || char === '\r')) { if (char === '\r' && input[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [headers = [], ...data] = rows;
  return data.filter(r => r.some(Boolean)).map(r => Object.fromEntries(headers.map((key, i) => [key.replace(/^\uFEFF/, ''), r[i] ?? ''])));
}

function flattenXmlRow(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!value || typeof value !== 'object') return result;
  for (const [key, raw] of Object.entries(value)) {
    if (key === '#text') continue;
    if (raw && typeof raw === 'object') {
      const nested = raw as Record<string, unknown>;
      result[key] = String(nested['#text'] ?? '');
      for (const [attribute, attributeValue] of Object.entries(nested)) if (attribute !== '#text') result[`${key}_${attribute}`] = String(attributeValue ?? '');
    } else result[key] = String(raw ?? '');
  }
  return result;
}

function normalizeRows(name: string, bytes: Uint8Array, tableInfo: TableIndex): TableRecord[] {
  const table = name.replace(/\.(csv|xml)$/i, '');
  let rows: Record<string, string>[];
  if (name.endsWith('.csv')) {
    const charset = /latin|8859/i.test(tableInfo.charset ?? '') ? 'iso-8859-1' : 'utf-8';
    rows = parseCsv(new TextDecoder(charset).decode(bytes), tableInfo.separator ?? ',');
  } else {
    const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', textNodeName: '#text', parseTagValue: false, parseAttributeValue: false }).parse(new TextDecoder().decode(bytes));
    const singular = table === 'pqrs' ? 'pqr' : 'empleado';
    const root = xml[table] ?? xml;
    const values = root[singular] ?? [];
    rows = (Array.isArray(values) ? values : [values]).map(flattenXmlRow);
  }
  const key = ({ clientes: 'cliente_id', transacciones: 'tx_id', pqrs: 'radicado', empleados: 'id' } as Record<string, string>)[table];
  if (!key) throw new Error(`Unknown table ${table}`);
  return rows.map(columns => ({ id: `${table}:${columns[key]}`, table, columns }));
}

async function normalizeDoc(info: DocIndex, bytes: Uint8Array): Promise<DocRecord> {
  let body = ''; const metadata: Record<string, string> = {};
  if (info.format === 'pdf') {
    const parser = new PDFParse({ data: bytes });
    try {
      const content = await parser.getText();
      const details = await parser.getInfo();
      body = content.text;
      const raw = (details as unknown as { info?: Record<string, unknown> }).info ?? (details as unknown as Record<string, unknown>);
      const allowed = new Set(['title', 'author', 'subject', 'keywords', 'creator', 'producer', 'creationdate', 'moddate']);
      for (const [key, value] of Object.entries(raw)) if (allowed.has(key.toLowerCase()) && typeof value === 'string' && value.trim()) metadata[key.toLowerCase()] = value;
      const xmpMeta = (details as unknown as { metadata?: Record<string, unknown> | { getAll?: () => Record<string, unknown> } | undefined }).metadata;
      let xmp: Record<string, unknown> = {};
      if (xmpMeta && typeof xmpMeta === 'object') {
        if ('getAll' in xmpMeta && typeof (xmpMeta as { getAll?: () => Record<string, unknown> }).getAll === 'function') {
          xmp = (xmpMeta as { getAll?: () => Record<string, unknown> }).getAll!();
        } else {
          xmp = xmpMeta as Record<string, unknown>;
        }
      }
      const xmpNames: Record<string, string> = { 'dc:title': 'title', 'dc:creator': 'author', 'dc:description': 'subject', 'pdf:keywords': 'keywords' };
      for (const [key, value] of Object.entries(xmp)) {
        const mapped = xmpNames[key.toLowerCase()];
        if (mapped && !metadata[mapped] && typeof value === 'string' && value.trim()) metadata[mapped] = value;
      }
    } catch (error) { throw new Error(`PDF processing failed for ${info.id}: ${error instanceof Error ? error.message : 'unknown error'}`); }
    finally { await parser.destroy(); }
  } else {
    body = new TextDecoder().decode(bytes);
    if (info.format === 'md' && body.startsWith('---')) {
      const end = body.indexOf('\n---', 3);
      if (end > 0) for (const line of body.slice(3, end).split(/\r?\n/)) {
        const match = line.match(/^([\w-]+):\s*(.*)$/); if (match) metadata[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
      }
    }
    if (info.format === 'html') for (const tag of body.match(/<meta\b[^>]*>/gi) ?? []) {
      const attributes = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1].toLowerCase(), match[3]]));
      const key = attributes.name ?? attributes.property;
      if (key && attributes.content !== undefined) metadata[key] = attributes.content;
    }
  }
  const htmlTitle = info.format === 'html' ? body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() : undefined;
  const title = metadata.title ?? htmlTitle ?? body.match(/^\s*#\s+(.+)$/m)?.[1] ?? info.filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
  return { id: info.id, format: info.format, filename: info.filename, title, body, metadata };
}

export async function ingest(client: SourceClient): Promise<Ingested> {
  const [channels, users, docsIndex, tablesIndex, index] = await Promise.all([
    client.json<SourceChannel[]>('/chats/channels'), client.json<SourceUser[]>('/chats/users'),
    client.json<DocIndex[]>('/docs'), client.json<TableIndex[]>('/tables'),
    client.json<Ingested['index']>('/record_index'),
  ]);
  const chats: ChatRecord[] = []; const uidByChat = new Map<string, string>();
  const unknownBots = new Set<string>();
  const userMap = new Map(users.map(u => [u.id, u]));
  for (const channel of channels) {
    const channelName = channel.name ?? channel.id;
    const dates = await client.json<string[]>(`/chats/${encodeURIComponent(channelName)}`);
    for (const date of dates) {
      const messages = await client.json<SourceMessage[]>(`/chats/${encodeURIComponent(channelName)}/${encodeURIComponent(date)}`);
      for (const message of messages) {
        const author = userMap.get(message.user);
        if (!author && message.subtype === 'bot_message') unknownBots.add(message.user);
        chats.push({ id: message.client_msg_id, thread_id: `${channelName}:${message.thread_ts ?? message.ts}`, author: author?.real_name ?? author?.profile?.real_name ?? author?.name ?? author?.username ?? (message.subtype === 'bot_message' ? 'Bot' : ''), ts: message.ts, text: message.text, attachments: (message.files ?? []).map(f => ({ filename: f.name ?? f.title ?? '' })) });
        uidByChat.set(message.client_msg_id, message.user);
      }
    }
  }
  const docs: DocRecord[] = [];
  for (const uid of new Set(uidByChat.values())) if (!userMap.has(uid)) users.push({ id: uid, real_name: unknownBots.has(uid) ? 'Bot' : '', is_bot: unknownBots.has(uid) });
  for (const info of docsIndex) docs.push(await normalizeDoc(info, await client.bytes(`/docs/${encodeURIComponent(info.id)}`)));
  const tables: TableRecord[] = [];
  for (const info of tablesIndex) tables.push(...normalizeRows(info.name, await client.bytes(`/tables/${encodeURIComponent(info.name)}`), info));
  return { chats, docs, tables, users, uidByChat, index };
}
