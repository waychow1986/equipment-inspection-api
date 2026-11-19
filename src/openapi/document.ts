/**
 * Static OpenAPI 3.0.3 document (TD-014). Must never contain credentials, example tokens,
 * digests, holder identifiers or connection information.
 */
const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
});

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: '设备巡检记录服务',
    version: '1.0.0',
    description: '门店设备巡检结果的提交与按设备查询。业务接口需要 Authorization: Bearer <访问令牌>。',
  },
  servers: [{ url: '/' }],
  paths: {
    '/v1/inspection-records': {
      post: {
        operationId: 'submitInspectionRecord',
        summary: '提交巡检记录（submit inspection record）',
        description: '仅巡检员（inspector）可调用；巡检员与提交时间由服务确定，请求体中的同类字段被忽略。',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['deviceId', 'storeId', 'conclusion'],
                properties: {
                  deviceId: { type: 'string', minLength: 1, maxLength: 128, description: '设备标识' },
                  storeId: { type: 'string', minLength: 1, maxLength: 128, description: '门店标识' },
                  conclusion: {
                    type: 'string',
                    enum: ['NORMAL', 'ABNORMAL'],
                    description: '巡检结论：NORMAL=正常，ABNORMAL=异常',
                  },
                  note: { type: 'string', nullable: true, maxLength: 2000, description: '备注，可选' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: '已保存的记录',
            headers: {
              Location: {
                description: '该设备历史记录的查询地址：/v1/inspection-records?deviceId=<URL 编码的设备标识>',
                schema: { type: 'string' },
              },
            },
            content: { 'application/json': { schema: { $ref: '#/components/schemas/InspectionRecord' } } },
          },
          '400': errorResponse('输入不符合要求（VALIDATION_FAILED）'),
          '401': errorResponse('未识别身份（UNAUTHENTICATED）'),
          '403': errorResponse('无权执行该操作（FORBIDDEN）'),
          '413': errorResponse('请求体超过 16 KiB（VALIDATION_FAILED，body TOO_LARGE）'),
          '503': errorResponse('服务暂不可用（SERVICE_UNAVAILABLE）'),
        },
      },
    },
    '/healthz': {
      get: {
        operationId: 'healthCheck',
        summary: '健康检查',
        description: '平台使用，无需身份。',
        responses: {
          '200': {
            description: '可用',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { status: { type: 'string', enum: ['ok'] } } },
              },
            },
          },
          '503': {
            description: '不可用',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { status: { type: 'string', enum: ['unavailable'] } } },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer' },
    },
    schemas: {
      InspectionRecord: {
        type: 'object',
        required: ['recordId', 'deviceId', 'storeId', 'conclusion', 'note', 'inspectorId', 'submittedAt'],
        properties: {
          recordId: { type: 'string', format: 'uuid', description: '记录标识' },
          deviceId: { type: 'string', description: '设备标识' },
          storeId: { type: 'string', description: '门店标识' },
          conclusion: { type: 'string', enum: ['NORMAL', 'ABNORMAL'], description: '巡检结论：NORMAL=正常，ABNORMAL=异常' },
          note: { type: 'string', nullable: true, description: '备注；未填写时为 null' },
          inspectorId: { type: 'string', description: '巡检员（令牌持有人标识）' },
          submittedAt: { type: 'string', format: 'date-time', description: '提交时间（UTC，毫秒精度）' },
        },
      },
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                enum: ['UNAUTHENTICATED', 'FORBIDDEN', 'VALIDATION_FAILED', 'NOT_FOUND', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR'],
              },
              message: { type: 'string' },
              fields: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['field', 'reason'],
                  properties: {
                    field: { type: 'string', enum: ['deviceId', 'storeId', 'conclusion', 'note', 'body'] },
                    reason: {
                      type: 'string',
                      enum: ['REQUIRED', 'INVALID_TYPE', 'INVALID_VALUE', 'TOO_LONG', 'MALFORMED', 'TOO_LARGE'],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
