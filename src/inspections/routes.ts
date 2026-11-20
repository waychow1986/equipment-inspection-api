import type { FastifyInstance } from 'fastify';
import { sendError } from '../http/errors.js';
import { newRecordId, type InspectionRepository } from './repository.js';
import { validateDeviceQuery, validateSubmission } from './validation.js';

export const RECORDS_PATH = '/v1/inspection-records';

export function registerInspectionRoutes(app: FastifyInstance, repository: InspectionRepository): void {
  app.post(RECORDS_PATH, { config: { allowedRole: 'inspector' } }, async (request, reply) => {
    const result = validateSubmission(request.body);
    if (!result.ok) return sendError(reply, 'VALIDATION_FAILED', { fields: result.fields });

    const principal = request.principal;
    if (!principal) return sendError(reply, 'UNAUTHENTICATED');

    const record = await repository.insert({
      ...result.value,
      recordId: newRecordId(),
      inspectorId: principal.holder,
    });
    reply.header('Location', `${RECORDS_PATH}?deviceId=${encodeURIComponent(record.deviceId)}`);
    return reply.code(201).send(record);
  });

  app.get(RECORDS_PATH, { config: { allowedRole: 'manager' } }, async (request, reply) => {
    const result = validateDeviceQuery(request.query);
    if (!result.ok) return sendError(reply, 'VALIDATION_FAILED', { fields: result.fields });

    const records = await repository.listByDevice(result.value);
    return reply.code(200).send({ deviceId: result.value, records });
  });
}
