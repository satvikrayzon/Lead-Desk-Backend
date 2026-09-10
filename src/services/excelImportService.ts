import ExcelJS from 'exceljs';
import { Types } from 'mongoose';
import { Lead, LeadAssignment, LeadImportBatch } from '../models';
import { ImportErrorRow } from '../models/LeadImportBatch';

const HEADER_MAP: Record<string, string> = {
  // State / location
  state: 'state',
  district: 'district',
  city: 'city',

  // Vendor / company identity
  vendorid: 'vendorId',
  vendorcode: 'vendorId',
  vendorno: 'vendorId',
  firmcode: 'vendorId',
  vendorname: 'companyName',
  firmname: 'companyName',
  companyname: 'companyName',
  company: 'companyName',
  firm: 'companyName',
  name: 'companyName',

  // Contact
  contactperson: 'contactPerson',
  personname: 'contactPerson',
  contactname: 'contactPerson',
  contactemail: 'contactEmail',
  email: 'contactEmail',
  emailid: 'contactEmail',
  mail: 'contactEmail',
  contactmobile: 'contactMobile',
  mobilenumber: 'contactMobile',
  mobile: 'contactMobile',
  phone: 'contactMobile',
  phonenumber: 'contactMobile',
  contactno: 'contactMobile',
  contactnumber: 'contactMobile',
  mobileno: 'contactMobile',
  cellphone: 'contactMobile',

  // Other vendor fields
  address: 'address',
  website: 'website',
  rating: 'rating',
  ratingcount: 'ratingCount',
  installedcapacitykwp: 'currentInstallationCapacityKw',
  installedcapacity: 'currentInstallationCapacityKw',
  capacitykwp: 'currentInstallationCapacityKw',
  capacitykw: 'currentInstallationCapacityKw',
  installationscount: 'installationsCount',
};

/** Insert chunk size — keeps memory and Mongo round-trips reasonable. */
const INSERT_CHUNK_SIZE = 500;
const MAX_STORED_ERRORS = 100;

function normalizeHeader(text: unknown): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cellText(cell: ExcelJS.CellValue | null | undefined): string | null {
  if (cell == null) return null;
  if (typeof cell === 'object' && 'text' in cell && cell.text != null) return String(cell.text).trim();
  if (typeof cell === 'object' && 'result' in cell && cell.result != null) {
    return cellText(cell.result as ExcelJS.CellValue);
  }
  if (cell instanceof Date) return cell.toISOString();
  // Avoid scientific notation for phone-like numbers from Excel.
  if (typeof cell === 'number' && Number.isFinite(cell) && Math.abs(cell) >= 1e9) {
    return Math.round(cell).toString();
  }
  return String(cell).trim();
}

function normalizeMobile(raw: string | null | undefined): string {
  if (!raw) return '';
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  return cleaned.replace(/\D/g, '');
}

function cellNumber(cell: ExcelJS.CellValue | null | undefined): number | null {
  const text = cellText(cell);
  if (!text) return null;
  const n = Number(text);
  return Number.isNaN(n) ? null : n;
}

type ImportRecord = Record<string, string | number | null | undefined>;

type PreparedLead = {
  rowNumber: number;
  doc: Record<string, unknown>;
};

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
      'Could not recognize any columns. Expected headers like "Firm Name" / "Vendor Name", "Mobile Number" / "Contact Mobile", "District", "Vendor Code", etc.',
    );
  }

  const mappedFields = new Set(Object.values(columnIndexToField));
  if (!mappedFields.has('companyName') && !mappedFields.has('contactMobile')) {
    throw new Error(
      'Excel headers were found, but no firm/vendor name or mobile column was recognized. ' +
        'Use columns like "Firm Name" / "Vendor Name" and "Mobile Number" / "Contact Mobile".',
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

  const assignTo = new Types.ObjectId(params.assignToUserId);
  const uploadedBy = new Types.ObjectId(params.uploadedByUserId);

  // ---- Pass 1: parse every data row (no DB calls) ----
  let totalRows = 0;
  let skippedCount = 0;
  const rowErrors: ImportErrorRow[] = [];
  const prepared: PreparedLead[] = [];
  const vendorIdsInFile: string[] = [];
  const seenVendorIds = new Set<string>();
  let sheetSequence = 0;

  const pushError = (row: number, message: string) => {
    if (rowErrors.length < MAX_STORED_ERRORS) {
      rowErrors.push({ row, message });
    }
  };

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    if (row.cellCount === 0) continue;

    totalRows += 1;
    try {
      const record: ImportRecord = {};
      for (const [colIndex, field] of Object.entries(columnIndexToField)) {
        const cell = row.getCell(Number(colIndex)).value;
        const isNumeric = [
          'rating',
          'ratingCount',
          'currentInstallationCapacityKw',
          'installationsCount',
        ].includes(field);
        record[field] = isNumeric ? cellNumber(cell) : cellText(cell);
      }

      const companyName = (record.companyName as string) || (record.contactPerson as string) || '';
      const contactMobile = normalizeMobile(record.contactMobile as string | null | undefined);

      if (!companyName && !contactMobile) {
        totalRows -= 1;
        continue;
      }
      if (!contactMobile) {
        throw new Error('Missing Contact Mobile / Mobile Number.');
      }

      const vendorId = record.vendorId ? String(record.vendorId).trim() : '';
      if (vendorId) {
        if (seenVendorIds.has(vendorId)) {
          skippedCount += 1;
          continue;
        }
        seenVendorIds.add(vendorId);
        vendorIdsInFile.push(vendorId);
      }

      const district = record.district ? String(record.district) : undefined;
      const city = record.city ? String(record.city) : district;
      sheetSequence += 1;

      prepared.push({
        rowNumber,
        doc: {
          vendorId: vendorId || undefined,
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
          district,
          city,
          name: (record.contactPerson as string) || companyName || 'Unknown',
          phoneNumber: contactMobile,
          company: companyName || undefined,
          importBatchId: batch._id,
          importRowNumber: sheetSequence,
          leadStatus: 'open',
          leadStage: 'Not Contacted',
          callCount: 0,
        },
      });
    } catch (err) {
      pushError(rowNumber, err instanceof Error ? err.message : 'Import failed.');
    }
  }

  // ---- Pass 2: one query for existing vendor IDs ----
  const existingVendorIds = new Set<string>();
  if (vendorIdsInFile.length > 0) {
    for (let i = 0; i < vendorIdsInFile.length; i += INSERT_CHUNK_SIZE) {
      const slice = vendorIdsInFile.slice(i, i + INSERT_CHUNK_SIZE);
      const found = await Lead.find({ vendorId: { $in: slice } }).select('vendorId').lean();
      for (const doc of found) {
        if (doc.vendorId) existingVendorIds.add(String(doc.vendorId));
      }
    }
  }

  const toInsert = prepared.filter((item) => {
    const vid = item.doc.vendorId ? String(item.doc.vendorId) : '';
    if (vid && existingVendorIds.has(vid)) {
      skippedCount += 1;
      return false;
    }
    return true;
  });

  // ---- Pass 3: bulk insert leads + assignments ----
  let createdCount = 0;
  for (let i = 0; i < toInsert.length; i += INSERT_CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + INSERT_CHUNK_SIZE);
    try {
      const inserted = await Lead.insertMany(
        chunk.map((c) => c.doc),
        { ordered: false },
      );
      createdCount += inserted.length;

      if (inserted.length > 0) {
        await LeadAssignment.insertMany(
          inserted.map((lead) => ({
            leadId: lead._id,
            agentId: assignTo,
            assignedBy: uploadedBy,
            isActive: true,
            assignedAt: new Date(),
          })),
          { ordered: false },
        );
      }
    } catch (err: unknown) {
      // ordered:false may still throw AggregateError / BulkWriteError after partial success
      const anyErr = err as {
        insertedDocs?: { _id: Types.ObjectId }[];
        result?: { nInserted?: number };
        writeErrors?: { index: number; errmsg?: string }[];
        message?: string;
      };

      const insertedDocs = anyErr.insertedDocs;
      if (Array.isArray(insertedDocs) && insertedDocs.length > 0) {
        createdCount += insertedDocs.length;
        try {
          await LeadAssignment.insertMany(
            insertedDocs.map((lead) => ({
              leadId: lead._id,
              agentId: assignTo,
              assignedBy: uploadedBy,
              isActive: true,
              assignedAt: new Date(),
            })),
            { ordered: false },
          );
        } catch (_) {
          // Assignments may partially fail; surface as row errors below.
        }
      } else if (typeof anyErr.result?.nInserted === 'number') {
        createdCount += anyErr.result.nInserted;
      }

      if (Array.isArray(anyErr.writeErrors)) {
        for (const we of anyErr.writeErrors) {
          const src = chunk[we.index];
          pushError(src?.rowNumber ?? 0, we.errmsg || 'Insert failed.');
        }
      } else {
        pushError(chunk[0]?.rowNumber ?? 0, anyErr.message || 'Bulk insert failed.');
      }
    }
  }

  const errorCount = rowErrors.length;
  batch.totalRows = totalRows;
  batch.createdCount = createdCount;
  batch.skippedCount = skippedCount;
  batch.errorCount = errorCount;
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
