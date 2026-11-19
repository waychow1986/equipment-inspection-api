import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../../src/openapi/document.js';

type Json = Record<string, unknown>;

describe('OpenAPI document', () => {
  const doc = openApiDocument as unknown as Json;
  const paths = doc.paths as Record<string, Json>;

  it('is an OpenAPI 3.0.3 document with relative server and bearer scheme', () => {
    expect(doc.openapi).toBe('3.0.3');
    expect(doc.info).toMatchObject({ title: '设备巡检记录服务', version: '1.0.0' });
    expect(doc.servers).toEqual([{ url: '/' }]);
    expect((doc.components as Json).securitySchemes).toEqual({ bearerAuth: { type: 'http', scheme: 'bearer' } });
  });

  it('lists only the business route and health check', () => {
    expect(Object.keys(paths).sort()).toEqual(['/healthz', '/v1/inspection-records']);
    const health = JSON.stringify(paths['/healthz']);
    expect(health).toContain('健康检查');
    expect(health).not.toMatch(/inspection|record|巡检/i);
  });

  it('describes the submit operation with an inline request schema', () => {
    const post = (paths['/v1/inspection-records'] as Json).post as Json;
    expect(post.operationId).toBe('submitInspectionRecord');
    expect(post.summary).toContain('提交巡检记录（submit inspection record）');
    expect(post.security).toEqual([{ bearerAuth: [] }]);
    const requestBody = post.requestBody as Json;
    expect(requestBody.required).toBe(true);
    const schema = ((requestBody.content as Json)['application/json'] as Json).schema as Json;
    expect(JSON.stringify(schema)).not.toMatch(/\$ref|oneOf|anyOf/);
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['deviceId', 'storeId', 'conclusion']);
    expect(schema).not.toHaveProperty('additionalProperties');
    const props = schema.properties as Record<string, Json>;
    expect(Object.keys(props)).toEqual(['deviceId', 'storeId', 'conclusion', 'note']);
    expect(props.deviceId).toMatchObject({ type: 'string', minLength: 1, maxLength: 128 });
    expect(props.storeId).toMatchObject({ type: 'string', minLength: 1, maxLength: 128 });
    expect(props.conclusion).toMatchObject({ type: 'string', enum: ['NORMAL', 'ABNORMAL'] });
    expect(props.conclusion?.description).toContain('NORMAL=正常');
    expect(props.note).toMatchObject({ type: 'string', nullable: true, maxLength: 2000 });
    expect(Object.keys(post.responses as Json).sort()).toEqual(['201', '400', '401', '403', '413', '503']);
  });

  it('contains no credentials or example tokens', () => {
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    expect(text).not.toMatch(/Bearer [A-Za-z0-9]/);
    expect(text).not.toMatch(/password|postgres:\/\//i);
  });
});
