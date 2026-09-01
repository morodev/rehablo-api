import { Request, Response } from 'express';
import { Op } from 'sequelize';
import { asyncHandler } from '../../../utils/asyncHandler.js';
import { sendErrorResponse, sendSuccessResponse } from '../../../utils/response.js';
import { Tenant, Structure } from '../../auth/models/index.js';
import Patient from '../../patients/models/patient.model.js';
import {
    Evaluation,
    HumanBodyAnswer,
    HumanBodyAnswerInstance,
    HumanBodyArticularity,
    HumanBodyPoint,
    HumanBodyQuestion,
    HumanBodyQuestionnaire,
    HumanBodyQuestionnaireInstance,
    HumanBodyStrength,
    HumanBodySymptom,
    TestInstance,
    UserAnswer,
    UserScaleInstance,
    Scale,
    QuestionScale,
    AnswerScale,
    Test
} from '../../evaluations/models/index.js';
import Observation from '../../measurements/models/observation.model.js';
import { ProtocolInstance, ProtocolPhaseInstance } from '../../protocols/models/index.js';
import {
    Exercise,
    ProtocolPhaseTemplate,
    ProtocolTemplate,
    ProtocolTemplateExercise
} from '../../protocols/models/catalog/index.js';
import AgendaEvent from '../../agenda/models/agendaEvent.model.js';
import { Invoice, InvoicePayment, InvoiceProduct, InvoiceService } from '../../invoice/models/index.js';
import PatientPortalAudit from '../models/patientPortalAudit.model.js';

const DEFAULT_LIMIT = 50;

function pageLimit(req: Request): number {
    const requested = Number(req.query.limit ?? DEFAULT_LIMIT);
    return Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 100) : DEFAULT_LIMIT;
}

function context(req: Request) {
    return {
        userId: ((req.user?.sub as string | undefined) ?? req.user?.id)!,
        tenantId: req.user!.tid as string,
        patientId: req.user!.pid as string,
        accessId: req.user!.patientAccessId as string
    };
}

async function audit(req: Request, resource: string, resourceId?: string) {
    const ctx = context(req);
    await PatientPortalAudit.schema(req.tenantSchema!).create({
        accessId: ctx.accessId,
        userId: ctx.userId,
        patientId: ctx.patientId,
        action: 'READ',
        resource,
        resourceId: resourceId ?? null,
        outcome: 'SUCCESS',
        ipAddress: (req.ip ?? req.socket.remoteAddress ?? null)?.slice(0, 45) ?? null,
        userAgent: req.get('user-agent')?.slice(0, 255) ?? null
    });
}

/** Rimuove ricorsivamente metadati operativi e note mai destinate al paziente. */
function patientProjection(value: any): any {
    if (Array.isArray(value)) return value.map(patientProjection);
    if (!value || typeof value !== 'object') return value;
    const plain = typeof value.get === 'function' ? value.get({ plain: true }) : value;
    const forbidden = new Set([
        'notes',
        'note',
        'progressionNotes',
        'metadata',
        'rawFileId',
        'operatorId',
        'ownerUserId',
        'createdByUserId',
        'updatedByUserId',
        'userId',
        'tenantId',
        'patientId',
        'operatorText',
        'image',
        'appointmentPaymentNote',
        'appointmentPaymentRecordedBy',
        'missedArrivalReportedBy',
        'missedArrivalResolvedBy',
        'stsExcluded',
        'stsSent',
        'stsSentAt'
    ]);
    return Object.fromEntries(
        Object.entries(plain)
            .filter(([key]) => !forbidden.has(key))
            .map(([key, item]) => [key, patientProjection(item)])
    );
}

export const overview = asyncHandler(async (req: Request, res: Response) => {
    const ctx = context(req);
    const [patient, tenant] = await Promise.all([
        Patient.schema(req.tenantSchema!).findByPk(ctx.patientId),
        Tenant.findByPk(ctx.tenantId)
    ]);
    if (!patient || !tenant) return sendErrorResponse(res, 404, 'Cartella non trovata');

    const structureId = patient.get('structureId') as string | null;
    const structure = structureId
        ? await Structure.findOne({ where: { id: structureId, tenantId: ctx.tenantId } })
        : null;
    await audit(req, 'overview');

    return sendSuccessResponse(res, 200, {
        center: {
            id: tenant.get('id'),
            name: tenant.get('businessName') || 'Centro Rehablo',
            email: tenant.get('email'),
            phone: tenant.get('phone')
        },
        structure: structure ? {
            id: structure.get('id'),
            name: structure.get('name'),
            address: structure.get('address'),
            city: structure.get('city')
        } : null,
        patient: {
            id: patient.get('id'),
            name: patient.get('name'),
            surname: patient.get('surname'),
            birthday: patient.get('birthday'),
            fiscalCode: patient.get('fiscalCode'),
            gender: patient.get('gender')
        },
        relationshipStatus: req.patientPortalAccess!.get('status')
    }, 'Portale paziente caricato');
});

export const evaluations = asyncHandler(async (req: Request, res: Response) => {
    const rows = await Evaluation.schema(req.tenantSchema!).findAll({
        where: { patientId: context(req).patientId, status: 'COMPLETED' },
        attributes: ['id', 'date', 'title', 'status', 'structureId'],
        order: [['date', 'DESC']],
        limit: pageLimit(req)
    });
    await audit(req, 'evaluations');
    return sendSuccessResponse(res, 200, rows, 'Valutazioni concluse');
});

export const evaluationDetail = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const evaluation = await Evaluation.schema(schema).findOne({
        where: { id: req.params.evaluationId, patientId: context(req).patientId, status: 'COMPLETED' },
        attributes: { exclude: ['notes', 'userId'] },
        include: [
            { model: HumanBodyPoint.schema(schema) },
            { model: HumanBodySymptom.schema(schema) },
            { model: HumanBodyArticularity.schema(schema) },
            { model: HumanBodyStrength.schema(schema) },
            {
                model: HumanBodyQuestionnaireInstance.schema(schema),
                include: [
                    { model: HumanBodyQuestionnaire.schema(schema), attributes: ['title', 'description'] },
                    {
                        model: HumanBodyAnswerInstance.schema(schema),
                        as: 'answers',
                        include: [
                            { model: HumanBodyQuestion.schema(schema), as: 'question', attributes: ['text'] },
                            { model: HumanBodyAnswer.schema(schema), as: 'answer', attributes: ['text', 'isCorrect'] }
                        ]
                    }
                ]
            },
            {
                model: UserScaleInstance.schema(schema),
                include: [
                    { model: Scale, attributes: ['name', 'description', 'isFullBody'] },
                    {
                        model: UserAnswer.schema(schema),
                        include: [
                            { model: QuestionScale, attributes: ['description'] },
                            { model: AnswerScale, attributes: ['description', 'value'] }
                        ]
                    }
                ]
            },
            {
                model: TestInstance.schema(schema),
                attributes: { exclude: ['notes', 'userId'] },
                include: [{
                    model: Test,
                    required: false,
                    attributes: ['id', 'name', 'description', 'patientText', 'type', 'isFullBody']
                }]
            }
        ]
    });
    if (!evaluation) return sendErrorResponse(res, 404, 'Valutazione non disponibile');

    const observations = await Observation.schema(schema).findAll({
        where: { evaluationId: req.params.evaluationId, patientId: context(req).patientId, quality: 'GOOD' },
        attributes: { exclude: ['metadata', 'rawFileId', 'operatorId'] },
        order: [['effectiveDateTime', 'DESC']]
    });
    await audit(req, 'evaluation', req.params.evaluationId);
    return sendSuccessResponse(res, 200, patientProjection({
        ...evaluation.get({ plain: true }),
        observations
    }), 'Valutazione conclusa');
});

export const protocols = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const rows = await ProtocolInstance.schema(schema).findAll({
        where: { patientId: context(req).patientId },
        attributes: { exclude: ['notes', 'userId'] },
        include: [{ model: ProtocolTemplate, required: false }],
        order: [['startDate', 'DESC']],
        limit: pageLimit(req)
    });
    await audit(req, 'protocols');
    return sendSuccessResponse(res, 200, patientProjection(rows), 'Protocolli assegnati');
});

export const protocolDetail = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const row = await ProtocolInstance.schema(schema).findOne({
        where: { id: req.params.protocolId, patientId: context(req).patientId },
        attributes: { exclude: ['notes', 'userId'] },
        include: [
            { model: ProtocolTemplate, required: false },
            {
                model: ProtocolPhaseInstance.schema(schema),
                attributes: { exclude: ['progressionNotes'] },
                include: [{
                    model: ProtocolPhaseTemplate,
                    include: [{ model: ProtocolTemplateExercise, include: [Exercise] }]
                }]
            }
        ]
    });
    if (!row) return sendErrorResponse(res, 404, 'Protocollo non disponibile');
    await audit(req, 'protocol', req.params.protocolId);
    return sendSuccessResponse(res, 200, patientProjection(row), 'Protocollo assegnato');
});

export const measurements = asyncHandler(async (req: Request, res: Response) => {
    const rows = await Observation.schema(req.tenantSchema!).findAll({
        where: { patientId: context(req).patientId, quality: 'GOOD' },
        attributes: { exclude: ['metadata', 'rawFileId', 'operatorId'] },
        order: [['effectiveDateTime', 'DESC']],
        limit: pageLimit(req)
    });
    await audit(req, 'measurements');
    return sendSuccessResponse(res, 200, patientProjection(rows), 'Misurazioni concluse');
});

export const appointments = asyncHandler(async (req: Request, res: Response) => {
    const rows = await AgendaEvent.schema(req.tenantSchema!).findAll({
        where: { patientId: context(req).patientId },
        attributes: ['id', 'title', 'start', 'end', 'allDay', 'status', 'structureId', 'eventTypeId', 'invoiceId'],
        order: [['start', 'DESC']],
        limit: pageLimit(req)
    });
    await audit(req, 'appointments');
    return sendSuccessResponse(res, 200, rows, 'Appuntamenti del paziente');
});

export const invoices = asyncHandler(async (req: Request, res: Response) => {
    const rows = await Invoice.schema(req.tenantSchema!).findAll({
        where: {
            patientID: context(req).patientId,
            documentNumber: { [Op.not]: null }
        },
        attributes: [
            'id', 'emissionDate', 'invoiceNet', 'invoiceTotal', 'invoiceVAT', 'status',
            'paymentTerms', 'documentNumber', 'documentYear', 'documentType', 'isStamp',
            'stampAmount', 'stampChargedToPatient'
        ],
        order: [['emissionDate', 'DESC']],
        limit: pageLimit(req)
    });
    await audit(req, 'invoices');
    return sendSuccessResponse(res, 200, rows, 'Fatture del paziente');
});

export const invoiceDetail = asyncHandler(async (req: Request, res: Response) => {
    const schema = req.tenantSchema!;
    const row = await Invoice.schema(schema).findOne({
        where: {
            id: req.params.invoiceId,
            patientID: context(req).patientId,
            documentNumber: { [Op.not]: null }
        },
        include: [
            { model: InvoiceProduct.schema(schema), as: 'products' },
            { model: InvoiceService.schema(schema), as: 'services' },
            {
                model: InvoicePayment.schema(schema),
                as: 'payments',
                where: { status: 'POSTED' },
                required: false,
                attributes: ['id', 'amount', 'paidAt', 'method']
            }
        ]
    });
    if (!row) return sendErrorResponse(res, 404, 'Fattura non disponibile');
    await audit(req, 'invoice', req.params.invoiceId);
    return sendSuccessResponse(res, 200, patientProjection(row), 'Dettaglio fattura');
});

export default {
    overview,
    evaluations,
    evaluationDetail,
    protocols,
    protocolDetail,
    measurements,
    appointments,
    invoices,
    invoiceDetail
};
