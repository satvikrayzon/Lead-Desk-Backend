import ExcelJS from 'exceljs';
import { Lead, LeadAssignment, LeadImportBatch } from '../models';
import { ImportErrorRow } from '../models/LeadImportBatch';

const HEADER_MAP: Record<string, string> = {
  state: 'state',
  district: 'district',
  vendorid: 'vendorId',
  vendorname: 'companyName',
  contactperson: 'contactPerson',
  contactemail: 'contactEmail',
  contactmobile: 'contactMobile',
  address: 'address',
  website: 'website',
  rating: 'rating',
  ratingcount: 'ratingCount',
  installedcapacitykwp: 'currentInstallationCapacityKw',
  installationscount: 'installationsCount',
};

function normalizeHeader(text: unknown): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cellText(cell: ExcelJS.CellValue | null | undefined): string | null {
  if (cell == null) return null;
  if (typeof cell === 'object' && 'text' in cell && cell.text != null) return String(cell.text).trim();
  if (cell instanceof Date) return cell.toISOString();
  return String(cell).trim();
}

function cellNumber(cell: ExcelJS.CellValue | null | undefined): number | null {
  const text = cellText(cell);
  if (!text) return null;
  const n = Number(text);
  return Number.isNaN(n) ? null : n;
}

type ImportRecord = Record<string, string | number | null | undefined>;

export async function importLeadsFromBuffer(params: {
  buffer: Buffer;
  originalFilename?: string;
  uploadedByUserId: string;
  assignToUserId: string;
}) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(params.buffer as unknown as ExcelJS.Buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error('Workbook has no sheets.');

  const headerRow = sheet.getRow(1);
  const columnIndexToField: Record<number, string> = {};
  headerRow.eachCell((cell, colNumber) => {
    const field = HEADER_MAP[normalizeHeader(cell.text || cell.value)];
    if (field) columnIndexToField[colNumber] = field;
  });

  if (Object.keys(columnIndexToField).length === 0) {
    throw new Error(
      'Could not recognize any columns. Expected headers like "Vendor Name", "Contact Mobile", "State", "District", etc.',
    );
  }

  const batch = await LeadImportBatch.create({
    uploadedByUserId: params.uploadedByUserId,
    originalFilename: params.originalFilename,
    totalRows: 0,
    createdCount: 0,
    skippedCount: 0,
    errorCount: 0,
    rowErrors: [],
  });

  let totalRows = 0;
  let createdCount = 0;
  let skippedCount = 0;
  const rowErrors: ImportErrorRow[] = [];

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (row.cellCount === 0) continue;

    totalRows += 1;
    try {
      const record: ImportRecord = {};
      for (const [colIndex, field] of Object.entries(columnIndexToField)) {
        const cell = row.getCell(Number(colIndex)).value;
        const isNumeric = ['rating', 'ratingCount', 'currentInstallationCapacityKw', 'installationsCount'].includes(field);
        record[field] = isNumeric ? cellNumber(cell) : cellText(cell);
      }

      const companyName = (record.companyName as string) || (record.contactPerson as string) || '';
      const contactMobile = (record.contactMobile as string) || '';

      if (!companyName && !contactMobile) {
        totalRows -= 1;
        continue;
      }
      if (!contactMobile) {
        throw new Error('Missing Contact Mobile.');
      }

      if (record.vendorId) {
        const existing = await Lead.findOne({ vendorId: String(record.vendorId) });
        if (existing) {
          skippedCount += 1;
          continue;
        }
      }

      const lead = await Lead.create({
        vendorId: record.vendorId ? String(record.vendorId) : undefined,
        companyName: companyName || 'Unknown Vendor',
        contactPerson: record.contactPerson ? String(record.contactPerson) : undefined,
        contactEmail: record.contactEmail ? String(record.contactEmail) : undefined,
        contactMobile,
        address: record.address ? String(record.address) : undefined,
        website: record.website ? String(record.website) : undefined,
        rating: record.rating as number | undefined,
        ratingCount: record.ratingCount as number | undefined,
        currentInstallationCapacityKw: record.currentInstallationCapacityKw as number | undefined,
        installationsCount: record.installationsCount as number | undefined,
        state: record.state ? String(record.state) : undefined,
        district: record.district ? String(record.district) : undefined,
        name: (record.contactPerson as string) || companyName || 'Unknown',
        phoneNumber: contactMobile,
        company: companyName || undefined,
        importBatchId: batch._id,
        leadStatus: 'open',
        leadStage: 'not_contacted',
        callCount: 0,
      });

      await LeadAssignment.create({
        leadId: lead._id,
        agentId: params.assignToUserId,
        assignedBy: params.uploadedByUserId,
        isActive: true,
      });

      createdCount += 1;
    } catch (err) {
      rowErrors.push({ row: rowNumber, message: err instanceof Error ? err.message : 'Import failed.' });
    }
  }

  batch.totalRows = totalRows;
  batch.createdCount = createdCount;
  batch.skippedCount = skippedCount;
  batch.errorCount = rowErrors.length;
  batch.rowErrors = rowErrors;
  await batch.save();

  return batch;
}

export function formatImportBatch(batch: {
  _id: { toString(): string };
  totalRows: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  rowErrors: ImportErrorRow[];
}) {
  return {
    id: batch._id.toString(),
    total_rows: batch.totalRows,
    created_count: batch.createdCount,
    skipped_count: batch.skippedCount,
    error_count: batch.errorCount,
    errors: batch.rowErrors,
  };
}
