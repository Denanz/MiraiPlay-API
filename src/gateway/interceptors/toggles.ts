import overrides from '../../data/overrides.toggles.json';

/**
 * GET /config/toggles — накладываем свои значения поверх ответа upstream.
 * Так выключаются встроенные обновления и подставляются объявления.
 */
export function applyToggleOverrides(data: any): any {
  if (!data || typeof data !== 'object') return data;
  return { ...data, ...overrides };
}
