import type { StreamQuality, ResolvedPlayback } from './kodik.js';

/**
 * Резолвер потоков AniLibria — источник «Liberty» в списке озвучек Anixart.
 *
 * Ссылка приходит на iframe.php, подписанный `d`/`s`/`ip`, как у Kodik. Но здесь
 * весь список серий с HLS-манифестами лежит прямо в инлайновом JS для Playerjs,
 * искать отдельную запрятанную ручку не нужно.
 *
 * Качество тут регулярно доходит до 1080p, чего у Kodik по этому каталогу нет.
 */

const ALLOWED_HOSTS = new Set(['anixart.libria.fun']);
const BROWSER_UA = 'Mozilla/5.0';
const QUALITY_PRIORITY = ['1080p', '720p', '480p', '360p', '240p'];

export function isAllowedAniLibriaUrl(url: string): boolean {
  try {
    return ALLOWED_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

interface RawEpisode {
  id?: string;
  file?: string;
}

/** Ищет `]`, парную `[` на openIdx, не считая скобок внутри строк: метки
 *  качества в поле `file` сами записаны как "[720p]...". */
function findMatchingBracket(html: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Достаёт массив серий `file:[...]` из вызова `new Playerjs({...})`. Сам массив —
 *  валидный JSON, просто вложен в JS. */
function extractEpisodes(html: string): RawEpisode[] {
  const marker = 'file:[';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error('anilibria: episode list not found');
  const openIdx = start + marker.length - 1;
  const closeIdx = findMatchingBracket(html, openIdx);
  if (closeIdx === -1) throw new Error('anilibria: unterminated episode list');
  return JSON.parse(html.slice(openIdx, closeIdx + 1)) as RawEpisode[];
}

/** "[480p]url1,[720p]url2,[1080p]url3" → StreamQuality[], лучшее первым. */
function parseQualities(fileStr: string): StreamQuality[] {
  const byLabel = new Map<string, string>();
  for (const part of fileStr.split(/,(?=\[)/)) {
    const m = part.match(/^\[(\w+)\](.+)$/);
    if (m) byLabel.set(m[1]!, m[2]!);
  }
  const out: StreamQuality[] = [];
  for (const label of QUALITY_PRIORITY) {
    const url = byLabel.get(label);
    if (url) out.push({ label, url });
  }
  for (const [label, url] of byLabel) {
    if (!QUALITY_PRIORITY.includes(label)) out.push({ label, url });
  }
  return out;
}

export async function resolveAniLibria(rawUrl: string): Promise<ResolvedPlayback> {
  if (!isAllowedAniLibriaUrl(rawUrl)) throw new Error('anilibria host not allowed');
  const parsed = new URL(rawUrl);
  const ep = parsed.searchParams.get('ep');
  if (!ep) throw new Error('anilibria: missing ep param');

  const html = await fetch(rawUrl, {
    headers: { 'user-agent': BROWSER_UA, referer: 'https://anixart.tv/' },
  }).then((r) => r.text());

  const episodes = extractEpisodes(html);
  const match = episodes.find((e) => e.id === `s${ep}`);
  if (!match?.file) throw new Error('anilibria: episode not in response');

  const qualities = parseQualities(match.file);
  if (qualities.length === 0) throw new Error('anilibria: no playable stream found');

  return { qualities, defaultLabel: qualities[0]!.label };
}
