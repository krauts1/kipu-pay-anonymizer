export type DetectedSpan = { start: number; end: number; value: string; kind: 'email' | 'phone' | 'cedula' | 'plate' | 'passport' | 'name' | 'first_name'; strong: boolean };

const email = /(?<![\w.+-])[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
const spokenEmail = /\b[\w.+-]+\s+arroba\s+[\w-]+(?:\s+punto\s+[\w-]+)+\b/gi;
const labeled = [
  { kind: 'cedula', re: /\b(?:c[eé]dula|documento|CC|C\.C\.)\s*(?:n[úu]mero|n[°ºo.]?)?\s*[:#-]?\s*(\d{1,3}(?:[., ]\d{3}){2,3}|\d{6,12})\b/gi },
  { kind: 'phone', re: /\b(?:celular|tel[eé]fono|m[oó]vil|WhatsApp)\s*[:#-]?\s*(\+?\d[\d ().-]{8,17}\d)/gi },
  { kind: 'plate', re: /\b(?:placa|matr[ií]cula)\s*[:#-]?\s*([A-Z]{3}[- ]?\d{3})\b/gi },
  { kind: 'passport', re: /\b(?:pasaporte|passport)\s*[:#-]?\s*([A-Z]{1,2}\d{7,9})\b/gi },
] as const;
const namedPerson = /\b(?:me llamo|mi nombre es|soy|preparado por|firmado por|atendido por|contacto:|agente:|cliente:)\s+([A-ZÁÉÍÓÚÑ][\p{L}ÁÉÍÓÚÑáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}ÁÉÍÓÚÑáéíóúñ]+){1,3})/giu;
const contextualFirstName = /\b(?:hola|hi|soy|me llamo)\s+([A-ZÁÉÍÓÚÑ][\p{L}ÁÉÍÓÚÑáéíóúñ]{3,})\b/giu;
const personAttribute = /\b(?:data-person|data-author|data-name|data-contact|author)\s*=\s*(["'])([^"']+)\1/giu;
const htmlComment = /<!--[\s\S]*?-->/g;
const genericMailboxes = new Set(['soporte', 'support', 'info', 'ventas', 'contacto', 'contact', 'admin', 'noreply', 'no-reply', 'facturacion']);
const internationalMobile = /(?<!\d)\+57[\s().-]*3\d{2}[\s().-]*\d{3}[\s().-]*\d{4}(?!\d)/g;

export function canonicalSpokenEmail(value: string): string { return value.replace(/\s+arroba\s+/i, '@').replace(/\s+punto\s+/gi, '.').replace(/\s+/g, ''); }
export function isGenericMailbox(value: string): boolean { return genericMailboxes.has(value.split('@')[0].toLowerCase()); }

export function detectExplicit(text: string): DetectedSpan[] {
  const spans: DetectedSpan[] = [];
  for (const match of text.matchAll(email)) if (!isGenericMailbox(match[0])) spans.push({ start: match.index, end: match.index + match[0].length, value: match[0], kind: 'email', strong: true });
  for (const match of text.matchAll(spokenEmail)) spans.push({ start: match.index, end: match.index + match[0].length, value: match[0], kind: 'email', strong: true });
  for (const match of text.matchAll(internationalMobile)) spans.push({ start: match.index, end: match.index + match[0].length, value: match[0], kind: 'phone', strong: true });
  for (const { kind, re } of labeled) for (const match of text.matchAll(re)) {
    const value = match[1]; const start = match.index + match[0].lastIndexOf(value);
    spans.push({ start, end: start + value.length, value, kind, strong: true });
  }
  for (const match of text.matchAll(namedPerson)) {
    const value = match[1]; const start = match.index + match[0].lastIndexOf(value);
    if (!/^[A-ZÁÉÍÓÚÑ]/.test(value)) continue;
    spans.push({ start, end: start + value.length, value, kind: 'name', strong: false });
  }
  for (const match of text.matchAll(contextualFirstName)) {
    const value = match[1]; const start = match.index + match[0].lastIndexOf(value);
    spans.push({ start, end: start + value.length, value, kind: 'first_name', strong: false });
  }
  for (const match of text.matchAll(personAttribute)) {
    const value = match[2];
    if (!/^[A-ZÁÉÍÓÚÑ]/.test(value) || value.trim().split(/\s+/).length < 2 || value.length > 80) continue;
    const start = match.index + match[0].lastIndexOf(value);
    spans.push({ start, end: start + value.length, value, kind: 'name', strong: false });
  }
  for (const comment of text.matchAll(htmlComment)) {
    const value = comment[0].slice(4, -3).trim();
    if (!/^[A-ZÁÉÍÓÚÑ][\p{L}]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}]+){1,3}$/u.test(value)) continue;
    const start = comment.index + comment[0].indexOf(value);
    spans.push({ start, end: start + value.length, value, kind: 'name', strong: false });
  }
  return spans.sort((a, b) => a.start - b.start || b.end - a.end).filter((span, i, all) => !all.slice(0, i).some(other => other.start <= span.start && other.end >= span.end));
}

export function aliasFragment(name: string): string {
  const map: Record<string, string> = { a: '[aáàäâ]', e: '[eéèëê]', i: '[iíìïî]', o: '[oóòöô]', u: '[uúùüû]', n: '[nñ]' };
  const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const parts = [...normalized].map(char => {
    if (/\s/.test(char)) return '[\\s_-]+';
    const lower = char.toLowerCase();
    return map[lower] ?? char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return parts.join('');
}
