import { settings } from '../../config/settings.js';
import roleTable from '../../data/roles.json';
import verifiedList from '../../data/verified.json';
import sponsorLabelTable from '../../data/sponsor_labels.json';

/**
 * Правка ответов ради косметики: глобальный премиум, галочка и дополнительные
 * роли отдельным аккаунтам.
 *
 * Имена полей повторяют схему upstream API — это контракт данных, а не наш выбор.
 */

const verifiedIds = new Set((verifiedList as Array<number | string>).map(String));
const roleGrants = roleTable as Record<string, Array<{ name: string; color: string }>>;
// Своя подпись вместо «Спонсор» для конкретных аккаунтов.
const sponsorLabels = sponsorLabelTable as Record<string, string | string[]>;

function labelsFor(id: string): string[] | undefined {
  const v = sponsorLabels[id];
  if (!v) return undefined;
  return Array.isArray(v) ? v : [v];
}

function decorate(profile: Record<string, any>): void {
  profile.is_sponsor = true;
  profile.sponsorshipExpires = settings.PREMIUM_EXPIRES_AT;

  const id = String(profile.id);
  const labels = labelsFor(id);
  if (labels) profile.sponsor_labels = labels;

  if (!profile.is_verified && verifiedIds.has(id)) {
    profile.is_verified = true;
  }

  const grants = roleGrants[id];
  if (grants && grants.length > 0) {
    profile.roles = Array.isArray(profile.roles) ? [...profile.roles, ...grants] : [...grants];
  }
}

/** GET /profile/:id — плюшки лежат в `data.profile`. */
export function decorateProfileCard(data: any): any {
  if (data && typeof data.profile === 'object' && data.profile) {
    decorate(data.profile);
  }
  return data;
}

/** GET /profile/info — флаги текущего пользователя на верхнем уровне. */
export function decorateProfileInfo(data: any): any {
  if (data && typeof data === 'object') {
    data.is_sponsor = true;
    data.sponsorship_expires = settings.PREMIUM_EXPIRES_AT;
    const labels = data.id != null ? labelsFor(String(data.id)) : undefined;
    if (labels) data.sponsor_labels = labels;
  }
  return data;
}
