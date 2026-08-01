import { expect, test } from 'vitest';

import {
  isBadRequest,
  isRateLimited,
  TelegramApiError,
} from '../src/errors.ts';

test('isBadRequest is true only for a 400 TelegramApiError', () => {
  expect(isBadRequest(new TelegramApiError(400, 'Bad Request'))).toBe(true);
  expect(isBadRequest(new TelegramApiError(429, 'Too Many'))).toBe(false);
  expect(isBadRequest(new Error('plain'))).toBe(false);
  expect(isBadRequest(undefined)).toBe(false);
});

test('isRateLimited is true only for a 429 TelegramApiError', () => {
  expect(isRateLimited(new TelegramApiError(429, 'Too Many'))).toBe(true);
  expect(isRateLimited(new TelegramApiError(400, 'Bad Request'))).toBe(false);
  expect(isRateLimited(new Error('plain'))).toBe(false);
  expect(isRateLimited(undefined)).toBe(false);
});

test('TelegramApiError carries code + description + parameters', () => {
  const e = new TelegramApiError(400, 'nope');
  expect(e.error_code).toBe(400);
  expect(e.description).toBe('nope');
  expect(e).toBeInstanceOf(Error);
  expect(
    new TelegramApiError(429, 'slow down', { retry_after: 5 }).parameters,
  ).toEqual({ retry_after: 5 });
});
