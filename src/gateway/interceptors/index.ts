import { decorateProfileCard, decorateProfileInfo } from './perks.js';
import { applyToggleOverrides } from './toggles.js';

/**
 * Реестр правил, переписывающих ответ. Прокси заглядывает сюда на каждом запросе;
 * подошедшее правило меняет JSON-тело перед отдачей. Путь — как у upstream, без
 * префикса /api/v1.
 */

export interface Interceptor {
  matches(method: string, path: string): boolean;
  transform(data: any): any;
  /**
   * Если true, правило сработает даже на пустом ответе — тело считается `{}`.
   * Для случаев, когда наша подмена должна побеждать всегда.
   */
  force?: boolean;
}

const PROFILE_CARD_PATH = /^\/profile\/\d+\/?$/;

const interceptors: Interceptor[] = [
  {
    matches: (method, path) => method === 'GET' && path === '/profile/info',
    transform: decorateProfileInfo,
  },
  {
    matches: (method, path) => method === 'GET' && PROFILE_CARD_PATH.test(path),
    transform: decorateProfileCard,
  },
  {
    matches: (method, path) => method === 'GET' && path === '/config/toggles',
    transform: applyToggleOverrides,
    force: true,
  },
];

export function pickInterceptor(method: string, path: string): Interceptor | undefined {
  return interceptors.find((rule) => rule.matches(method, path));
}
