import overrides from '../../data/overrides.toggles.json';

/**
 * GET /config/toggles — shallow-merge our overrides on top of the upstream
 * payload (overrides win). Used to disable in-app updates and inject notices.
 */
export function applyToggleOverrides(data: any): any {
  if (!data || typeof data !== 'object') return data;
  return { ...data, ...overrides };
}
