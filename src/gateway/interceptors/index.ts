import { decorateProfileCard, decorateProfileInfo } from './perks.js';
import { applyToggleOverrides } from './toggles.js';

/**
 * Registry of post-response rewriters. The passthrough proxy consults this for
 * every request; a matching rule transforms a 200 JSON body before it is sent.
 * Path is the upstream path (the /api/v1 mount prefix already stripped).
 */

export interface Interceptor {
  matches(method: string, path: string): boolean;
  transform(data: any): any;
  /**
   * When true the transform runs even if upstream returned an empty/non-JSON
   * 200 (the body is treated as `{}`). Used for overrides that must always win.
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
