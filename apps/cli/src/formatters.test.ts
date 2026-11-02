import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AnalysisResult } from '@contractguard/core';
import { formatResult } from './formatters.js';

const result: AnalysisResult = {
  engineVersion: '1.1.0',
  generatedAt: '2026-09-16T00:00:00.000Z',
  policy: { id: 'contractguard-default', fingerprint: { algorithm: 'sha256', value: 'a'.repeat(64) } },
  source: {
    old: { title: 'API', version: '1', openapi: '3.1.0', fingerprint: { algorithm: 'sha256', value: 'b'.repeat(64) } },
    new: { title: 'API', version: '2', openapi: '3.1.0', fingerprint: { algorithm: 'sha256', value: 'c'.repeat(64) } },
  },
  score: 75,
  compatible: false,
  summary: { breaking: 1, potentiallyBreaking: 0, nonBreaking: 0, info: 0, total: 1 },
  changes: [{ id: '1', ruleId: 'operation.removed', severity: 'breaking', category: 'operation', location: 'GET /pets', message: 'Operation removed.', recommendation: 'Restore it.' }],
};

describe('CLI formatters', () => {
  it('formats a readable table', () => {
    const output = formatResult(result, 'table', { baseline: 'v1.yaml', candidate: 'v2.yaml' });
    assert.match(output, /Score 75\/100/);
    assert.match(output, /operation\.removed/);
  });

  it('formats JSON, Markdown, and standalone HTML', () => {
    assert.equal(JSON.parse(formatResult(result, 'json', { baseline: 'a', candidate: 'b' })).score, 75);
    const markdown = formatResult(result, 'markdown', { baseline: 'a', candidate: 'b' });
    assert.match(markdown, /# ContractGuard/);
    assert.match(markdown, /contractguard-default/);
    const html = formatResult(result, 'html', { baseline: 'a', candidate: 'b' });
    assert.match(html, /<!doctype html>/);
    assert.match(html, /Baseline SHA-256/);
  });

  it('escapes terminal control sequences in table output', () => {
    const hostile = structuredClone(result);
    hostile.changes[0]!.message = 'unsafe\u001b]52;clipboard\u0007message';
    const output = formatResult(hostile, 'table', { baseline: 'a', candidate: 'b' });
    assert.doesNotMatch(output, /\u001b|\u0007/);
    assert.match(output, /\\x1b/);
  });

  it('keeps partial coverage visible with no findings and escapes imported metadata', () => {
    const partial = structuredClone(result);
    partial.score = 100;
    partial.compatible = true;
    partial.changes = [];
    partial.summary = { breaking: 0, potentiallyBreaking: 0, nonBreaking: 0, info: 0, total: 0 };
    partial.coverage = { status: 'partial', truncated: true, warnings: [{
      code: 'UNSUPPORTED_WEBHOOKS', side: 'new', location: '#/webhooks',
      message: '<script>alert(1)</script>\u001b[31m',
      source: { file: 'openapi.yaml', pointer: '#/webhooks' },
    }] };
    partial.source.new.dialect = 'oas-3.1';
    partial.source.new.bundle = { entry: 'openapi.yaml', files: [{ path: 'schemas/order.yaml', fingerprint: { algorithm: 'sha256', value: 'd'.repeat(64) } }] };
    const table = formatResult(partial, 'table', { baseline: 'a', candidate: 'b' });
    assert.match(table, /Coverage: partial/);
    assert.match(table, /Warning list truncated/);
    assert.match(table, /schemas\/order.yaml/);
    assert.match(table, /openapi.yaml#\/webhooks/);
    assert.doesNotMatch(table, /\u001b/);
    const html = formatResult(partial, 'html', { baseline: 'a', candidate: 'b' });
    assert.match(html, /Coverage: partial/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(formatResult(partial, 'markdown', { baseline: 'a', candidate: 'b' }), /Coverage: partial/);
  });

  it('does not infer old report coverage and renders a single source fragment separator', () => {
    const sourced = structuredClone(result);
    sourced.changes[0]!.sourceLocations = { old: { file: 'schemas/order.yaml', pointer: '#/properties/id' } };
    for (const format of ['table', 'markdown', 'html'] as const) {
      const output = formatResult(sourced, format, { baseline: 'a', candidate: 'b' });
      assert.match(output, /Coverage: not recorded/);
      assert.doesNotMatch(output, /##\/properties/);
      assert.match(output.replaceAll('\\.', '.').replaceAll('\\#', '#'), /schemas\/order.yaml#\/properties\/id/);
    }
  });
});
