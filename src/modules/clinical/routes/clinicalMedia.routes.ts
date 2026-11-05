import {Router, type Request, type Response} from 'express';
import multer from 'multer';
import {createHash} from 'node:crypto';
import {sequelize} from '../../../config/database.js';
import {env} from '../../../config/env.js';
import {requireAuth, getCurrentTenantId} from '../../../middleware/auth.js';
import {resolveTenantSchema} from '../../../middleware/tenantSchema.js';
import {asyncHandler} from '../../../utils/asyncHandler.js';
import {sendSuccessResponse} from '../../../utils/response.js';
import {ClinicalRecord} from '../models/clinical.model.js';
import {loadClinicalPath, loadClinicalRecord, assertClinicalWrite, audit, withClinicalOperation} from '../services/clinical.service.js';
import {fail, text, uuid} from '../services/clinical.policy.js';
import {detectClinicalMime, clinicalFilename} from '../services/clinicalMedia.policy.js';
import {renderClinicalPdf} from '../services/clinicalPdf.service.js';
import RawFile from '../../measurements/models/rawFile.model.js';
import {localStorageAdapter} from '../../measurements/storage/localStorageAdapter.js';
import Patient from '../../patients/models/patient.model.js';
import User from '../../auth/models/user.model.js';
import Evaluation from '../../evaluations/models/evaluation.model.js';
import {assertEvaluationEditable} from '../../evaluations/services/evaluationGuard.js';

const router = Router();
const upload = multer({storage: multer.memoryStorage(), limits: {fileSize: env.maxUploadSizeMb * 1024 * 1024}}).single('file');
router.use(['/care-paths', '/clinical-documents', '/medical-reports'], requireAuth, resolveTenantSchema);

router.post('/care-paths/:pathId/documents/upload', upload, asyncHandler(async (req, res) => {
    if (!req.file) fail('Seleziona un file');
    const file = req.file!;
    const mimeType = detectClinicalMime(file.buffer);
    if (!mimeType) fail('Formato non supportato. Usa PDF, JPEG, PNG, WebP, MP4, MOV o WebM', 'UNSUPPORTED_MEDIA', 415);
    const originalName = clinicalFilename(file.originalname);
    const title = text(req.body.title || originalName, 'Titolo', 240, true)!;
    const evaluationId = req.body.evaluationId ? uuid(req.body.evaluationId)! : null;
    const operationId = uuid(req.body.operationId, 'Identificativo operazione')!;
    const checksumSha256 = createHash('sha256').update(file.buffer).digest('hex');
    let storagePath: string | null = null;
    let writesReadyToCommit = false;
    let result: Record<string,any>;
    try {
        result = await sequelize.transaction(async transaction => {
            const access = await loadClinicalPath(req, req.params.pathId, transaction);
            await assertClinicalWrite(req, access, transaction, access.path.kind === 'TRAINING' ? 'training' : undefined);
            if (evaluationId) {
                const evaluation = await Evaluation.schema(req.tenantSchema!).findByPk(evaluationId, {transaction});
                if (!evaluation || evaluation.patientId !== access.path.patientId || evaluation.carePathId !== access.path.id) fail('Valutazione e percorso non corrispondono');
                if(access.level!=='CLINICAL'&&evaluation.clinicalVisibility!=='OPERATIONAL')fail('Valutazione clinica non disponibile','NOT_FOUND',404);
                await assertEvaluationEditable(req.tenantSchema!, evaluationId, access.userId, transaction);
            }
            const uploaded = await withClinicalOperation<Record<string,any>>(req, operationId, 'document-upload', {pathId: access.path.id, title, originalName, checksumSha256, evaluationId}, transaction, async () => {
                const saved = await localStorageAdapter.save(getCurrentTenantId(req), file.buffer, originalName);
                storagePath = saved.storagePath;
                const raw = await RawFile.schema(req.tenantSchema!).create({tenantId: getCurrentTenantId(req), originalName, mimeType: mimeType!, sizeBytes: saved.sizeBytes, checksumSha256, storagePath, uploadedBy: access.userId}, {transaction});
                const record = await ClinicalRecord.schema(req.tenantSchema!).create({
                    carePathId: access.path.id, patientId: access.path.patientId, structureId: access.path.structureId,
                    authorUserId: access.userId, kind: 'DOCUMENT', title, status: 'DRAFT', visibility: access.level, version: 1, evaluationId,
                    data: {rawFileId: raw.id, documentType: mimeType!.startsWith('image/') ? 'PHOTO' : mimeType!.startsWith('video/') ? 'VIDEO' : 'DOCUMENT',
                        source: 'UPLOAD', reviewStatus: 'UNREAD', fileName: originalName, mimeType, sizeBytes: saved.sizeBytes, checksumSha256}
                }, {transaction});
                await audit(req, 'DOCUMENT_UPLOADED', transaction, access.path.id, record.id, 1);
                return record.get({plain: true});
            });
            if(access.level!=='CLINICAL'&&uploaded.visibility!=='OPERATIONAL')fail('Documento non disponibile','NOT_FOUND',404);
            const {record:current}=await loadClinicalRecord(req,String(uploaded.id),transaction);
            if(current.carePathId!==access.path.id)fail('Documento non disponibile','NOT_FOUND',404);
            writesReadyToCommit=true;
            return uploaded;
        });
    } catch (error) {
        if(storagePath){
            // A lost COMMIT reply is ambiguous. Preserve the original if verification fails
            // or the transaction reached commit; an orphan is safer than lost clinical data.
            let referenced=true;
            try {referenced=!!await RawFile.schema(req.tenantSchema!).findOne({where:{storagePath,tenantId:getCurrentTenantId(req)},attributes:['id']});}
            catch {console.error('[clinical-media] Upload cleanup verification unavailable; original retained');}
            if(!referenced&&!writesReadyToCommit)await localStorageAdapter.remove(storagePath).catch(()=>console.error('[clinical-media] Upload cleanup failed'));
        }
        throw error;
    }
    sendSuccessResponse(res,201,result,'Documento caricato');
}));

export async function sendClinicalDocument(req: Request, res: Response, record: ClinicalRecord) {
    if (record.kind !== 'DOCUMENT') fail('Documento non trovato', 'NOT_FOUND', 404);
    const raw = await RawFile.schema(req.tenantSchema!).findByPk(record.data.rawFileId);
    if (!raw || raw.tenantId !== getCurrentTenantId(req)) fail('File non disponibile', 'NOT_FOUND', 404);
    const bytes = await localStorageAdapter.read(raw.storagePath);
    const filename = encodeURIComponent(clinicalFilename(raw.originalName)).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    res.setHeader('Content-Type', raw.mimeType);
    res.setHeader('Content-Disposition', 'attachment; filename="documento"; filename*=UTF-8\'\'' + filename);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
}

export async function sendClinicalReport(req: Request, res: Response, record: ClinicalRecord) {
    if (record.kind !== 'REPORT' || record.status !== 'CONFIRMED') fail('Referto confermato non disponibile', 'NOT_FOUND', 404);
    const patient = await Patient.schema(req.tenantSchema!).findOne({where: {id: record.patientId, structureId: record.structureId}});
    if (!patient) fail('Paziente non disponibile', 'NOT_FOUND', 404);
    const author = await User.findByPk(record.authorUserId, {attributes: ['name','surname']});
    const patientName = [patient!.get('name'), patient!.get('surname')].filter(Boolean).join(' ');
    const authorName = author ? [author.get('name'), author.get('surname')].filter(Boolean).join(' ') : record.authorUserId;
    const buffer = await renderClinicalPdf({title: record.title, text: record.data.text, patientName, authorName, recordId: record.id,
        version: record.version, createdAt: new Date(record.get('createdAt') as string).toLocaleDateString('it-IT'), confirmed: true});
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="referto-' + record.id + '.pdf"');
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(buffer);
}
router.get('/clinical-documents/:id/download', asyncHandler(async (req, res) => {
    const {record} = await loadClinicalRecord(req, req.params.id);
    await sendClinicalDocument(req, res, record);
}));
router.get('/medical-reports/:id/pdf', asyncHandler(async (req, res) => {
    const {record} = await loadClinicalRecord(req, req.params.id);
    await sendClinicalReport(req, res, record);
}));
export default router;
