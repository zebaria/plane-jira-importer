import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseArgs, formatDate, validateEnv, truncate, formatSize, formatDuration, mimeFromFilename } from '../src/utils/helpers.js';

// ─── parseArgs ───────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses --flag as boolean true', () => {
    expect(parseArgs(['--dry-run'])).toEqual({ 'dry-run': true });
  });

  it('parses --key=value with equals sign', () => {
    expect(parseArgs(['--project-key=MYPROJ'])).toEqual({ 'project-key': 'MYPROJ' });
  });

  it('parses --key value as separate tokens', () => {
    expect(parseArgs(['--project-key', 'MYPROJ'])).toEqual({ 'project-key': 'MYPROJ' });
  });

  it('handles multiple mixed flags', () => {
    const result = parseArgs(['--dry-run', '--project-key=TEST', '--plane-project', 'abc-123']);
    expect(result).toEqual({
      'dry-run': true,
      'project-key': 'TEST',
      'plane-project': 'abc-123',
    });
  });

  it('returns empty object for no arguments', () => {
    expect(parseArgs([])).toEqual({});
  });

  it('treats --flag followed by --other as boolean', () => {
    const result = parseArgs(['--verbose', '--dry-run']);
    expect(result).toEqual({ verbose: true, 'dry-run': true });
  });
});

// ─── formatDate ──────────────────────────────────────────────────────────────

describe('formatDate', () => {
  it('formats ISO date string to YYYY-MM-DD', () => {
    expect(formatDate('2024-01-15T10:30:00Z')).toBe('2024-01-15');
  });

  it('formats date string without time component', () => {
    expect(formatDate('2024-06-15')).toBe('2024-06-15');
  });

  it('returns null for null input', () => {
    expect(formatDate(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(formatDate(undefined)).toBeNull();
  });

  it('returns null for invalid date string', () => {
    expect(formatDate('not-a-date')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(formatDate('')).toBeNull();
  });
});

// ─── validateEnv ─────────────────────────────────────────────────────────────

describe('validateEnv', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns empty array when all required vars are present', () => {
    process.env.FOO = 'bar';
    process.env.BAZ = 'qux';
    expect(validateEnv(['FOO', 'BAZ'])).toEqual([]);
  });

  it('returns names of missing variables', () => {
    process.env.FOO = 'bar';
    delete process.env.MISSING_VAR;
    expect(validateEnv(['FOO', 'MISSING_VAR'])).toEqual(['MISSING_VAR']);
  });

  it('returns all vars when none are set', () => {
    delete process.env.A;
    delete process.env.B;
    expect(validateEnv(['A', 'B'])).toEqual(['A', 'B']);
  });
});

// ─── truncate ────────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns string unchanged when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long strings and appends ellipsis', () => {
    expect(truncate('hello world', 6)).toBe('hello…');
  });

  it('returns empty string for null input', () => {
    expect(truncate(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(truncate(undefined)).toBe('');
  });

  it('returns string unchanged when exactly at limit', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });
});

// ─── formatSize ──────────────────────────────────────────────────────────────

describe('formatSize', () => {
  it('formats bytes', () => {
    expect(formatSize(512)).toBe('512B');
  });

  it('formats kilobytes', () => {
    expect(formatSize(2048)).toBe('2.0KB');
  });

  it('formats megabytes', () => {
    expect(formatSize(5 * 1024 * 1024)).toBe('5.0MB');
  });

  it('formats gigabytes', () => {
    expect(formatSize(2 * 1024 * 1024 * 1024)).toBe('2.0GB');
  });

  it('formats fractional sizes', () => {
    expect(formatSize(1536)).toBe('1.5KB');
  });
});

// ─── formatDuration ──────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats seconds only', () => {
    expect(formatDuration(45_000)).toBe('45s');
  });

  it('formats minutes and seconds', () => {
    expect(formatDuration(125_000)).toBe('2m 5s');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3_720_000)).toBe('1h 2m');
  });

  it('formats zero', () => {
    expect(formatDuration(0)).toBe('0s');
  });

  it('formats exactly one minute', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
  });
});

// ─── mimeFromFilename ────────────────────────────────────────────────────────

describe('mimeFromFilename', () => {
  it('detects PNG (lowercase)', () => {
    expect(mimeFromFilename('screenshot.png')).toBe('image/png');
  });

  it('detects PNG (uppercase)', () => {
    expect(mimeFromFilename('IMG_9488.PNG')).toBe('image/png');
  });

  it('detects JPEG (.jpg)', () => {
    expect(mimeFromFilename('photo.jpg')).toBe('image/jpeg');
  });

  it('detects JPEG (.jpeg)', () => {
    expect(mimeFromFilename('photo.jpeg')).toBe('image/jpeg');
  });

  it('detects JPEG (.JPG uppercase)', () => {
    expect(mimeFromFilename('IMG_0228.JPG')).toBe('image/jpeg');
  });

  it('detects PDF', () => {
    expect(mimeFromFilename('document.pdf')).toBe('application/pdf');
  });

  it('handles filenames with spaces', () => {
    expect(mimeFromFilename('Photo 2019-09-13 19_05_18.jpg')).toBe('image/jpeg');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(mimeFromFilename('data.xyz')).toBe('application/octet-stream');
  });

  it('returns octet-stream for no extension', () => {
    expect(mimeFromFilename('README')).toBe('application/octet-stream');
  });
});
