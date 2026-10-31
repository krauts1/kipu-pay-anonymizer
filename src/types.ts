export type SourceKind = 'chats' | 'docs' | 'tables';
export type ChatRecord = { id: string; thread_id: string; author: string; ts: string; text: string; attachments: { filename: string }[] };
export type DocRecord = { id: string; format: 'pdf' | 'html' | 'md'; filename: string; title: string; body: string; metadata: Record<string, string> };
export type TableRecord = { id: string; table: string; columns: Record<string, string> };
export type RecordValue = ChatRecord | DocRecord | TableRecord;
export type Entity = { entity_id: string; type: 'person' | 'organization_or_place'; originals: string[]; pseudonyms?: Record<string, string>; records: string[]; kept?: boolean; reason?: string };
export type RecordCounts = { chats: number; docs: number; tables: number };
