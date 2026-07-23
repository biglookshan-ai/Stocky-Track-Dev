import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { q } from './db.js';

export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;

const BLOCKED_TYPES = new Set([
  'application/javascript',
  'application/x-javascript',
  'image/svg+xml',
  'text/html',
]);
const BLOCKED_EXTENSIONS = new Set([
  '.app', '.bat', '.cmd', '.com', '.dmg', '.exe', '.html', '.htm',
  '.js', '.mjs', '.pkg', '.ps1', '.sh', '.svg',
]);

function attachmentRoot() {
  return path.join(process.env.DATA_DIR || path.join(process.cwd(), '.data'), 'adjustment-attachments');
}

export function normalizeAttachmentMeta({ filename, contentType, size }) {
  const originalName = String(filename || '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  const type = String(contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
  const bytes = Number(size);
  if (!originalName || originalName.length > 240) throw new Error('附件文件名无效');
  if (!Number.isInteger(bytes) || bytes <= 0) throw new Error('附件不能为空');
  if (bytes > MAX_ATTACHMENT_BYTES) throw new Error('单个附件不能超过 50 MB');
  if (BLOCKED_TYPES.has(type) || BLOCKED_EXTENSIONS.has(path.extname(originalName).toLowerCase())) {
    throw new Error('该附件类型不支持上传');
  }
  return { originalName, contentType: type || 'application/octet-stream', sizeBytes: bytes };
}

export async function listAdjustmentAttachments(adjustmentId) {
  const result = await q(
    `SELECT aa.id, aa.adjustment_id, aa.original_name, aa.content_type,
            aa.size_bytes, aa.created_at, s.display_name AS uploaded_by_name
     FROM adjustment_attachments aa
     LEFT JOIN staff s ON s.id=aa.uploaded_by
     WHERE aa.adjustment_id=$1
     ORDER BY aa.created_at, aa.id`,
    [Number(adjustmentId)],
  );
  return result.rows;
}

export async function storeAdjustmentAttachment({
  adjustmentId, staffId, filename, contentType, buffer,
}) {
  const id = Number(adjustmentId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('调整单无效');
  const meta = normalizeAttachmentMeta({ filename, contentType, size: buffer?.length });
  const adjustment = await q('SELECT status FROM adjustments WHERE id=$1', [id]);
  if (!adjustment.rowCount) throw new Error('调整单不存在');
  if (adjustment.rows[0].status !== 'draft') throw new Error('只有 Draft 调整单可以添加附件');
  const count = await q(
    'SELECT count(*)::int AS total FROM adjustment_attachments WHERE adjustment_id=$1',
    [id],
  );
  if (count.rows[0].total >= MAX_ATTACHMENTS) {
    throw new Error(`每张调整单最多 ${MAX_ATTACHMENTS} 个附件`);
  }

  const storageKey = `${id}/${crypto.randomUUID()}`;
  const fullPath = path.join(attachmentRoot(), storageKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer, { flag: 'wx', mode: 0o600 });
  try {
    const saved = await q(
      `INSERT INTO adjustment_attachments
         (adjustment_id, uploaded_by, original_name, content_type, size_bytes, storage_key)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [id, staffId || null, meta.originalName, meta.contentType, meta.sizeBytes, storageKey],
    );
    return (await listAdjustmentAttachments(id))
      .find((attachment) => Number(attachment.id) === Number(saved.rows[0].id));
  } catch (error) {
    await fs.unlink(fullPath).catch(() => {});
    throw error;
  }
}

export async function getAdjustmentAttachment(adjustmentId, attachmentId) {
  const result = await q(
    `SELECT id, adjustment_id, original_name, content_type, size_bytes, storage_key
     FROM adjustment_attachments
     WHERE id=$1 AND adjustment_id=$2`,
    [Number(attachmentId), Number(adjustmentId)],
  );
  if (!result.rowCount) return null;
  return { ...result.rows[0], fullPath: path.join(attachmentRoot(), result.rows[0].storage_key) };
}

export async function deleteAdjustmentAttachment(adjustmentId, attachmentId) {
  const id = Number(adjustmentId);
  const adjustment = await q('SELECT status FROM adjustments WHERE id=$1', [id]);
  if (!adjustment.rowCount) throw new Error('调整单不存在');
  if (adjustment.rows[0].status !== 'draft') throw new Error('只有 Draft 调整单可以删除附件');
  const attachment = await getAdjustmentAttachment(id, attachmentId);
  if (!attachment) throw new Error('附件不存在');
  await q('DELETE FROM adjustment_attachments WHERE id=$1 AND adjustment_id=$2', [
    Number(attachmentId), id,
  ]);
  await fs.unlink(attachment.fullPath).catch((error) => {
    if (error.code !== 'ENOENT') console.error('[attachments] delete failed:', error.message);
  });
}
