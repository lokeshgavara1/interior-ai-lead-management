import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';

/** Minimal Google Sheets API surface used by the CRM sync. */
export interface SheetsApi {
  /** Ensures a tab exists; returns its numeric sheetId. */
  ensureTab(spreadsheetId: string, title: string): Promise<number>;
  getValues(spreadsheetId: string, range: string): Promise<string[][]>;
  /** Writes values as RAW (never interpreted as formulas). */
  updateValues(spreadsheetId: string, range: string, values: (string | number)[][]): Promise<void>;
  clearValues(spreadsheetId: string, range: string): Promise<void>;
  /** Dropdown validation on a column (rows 2+). Non-strict: typed values are still allowed. */
  setDropdown(spreadsheetId: string, sheetId: number, columnIndex: number, options: string[]): Promise<void>;
  freezeHeader(spreadsheetId: string, sheetId: number): Promise<void>;
}

/** Credentials from GOOGLE_SERVICE_ACCOUNT_JSON (inline JSON) or GOOGLE_SERVICE_ACCOUNT_FILE (path). */
export function loadServiceAccount(json?: string, file?: string): { client_email: string; private_key: string } | null {
  const raw = json?.trim() ? json : file?.trim() ? readFileSync(file, 'utf8') : null;
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) throw new Error('Service account JSON is missing client_email / private_key');
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

export function createSheetsApi(creds: { client_email: string; private_key: string }): SheetsApi {
  const auth = new JWT({ email: creds.client_email, key: creds.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const base = 'https://sheets.googleapis.com/v4/spreadsheets';
  const req = async <T>(method: 'GET' | 'PUT' | 'POST', url: string, data?: unknown): Promise<T> =>
    (await auth.request<T>({ method, url, data, timeout: 20_000 })).data;
  const batchUpdate = (id: string, requests: unknown[]) => req('POST', `${base}/${id}:batchUpdate`, { requests });

  return {
    async ensureTab(id, title) {
      const meta = await req<{ sheets: { properties: { sheetId: number; title: string } }[] }>(
        'GET',
        `${base}/${id}?fields=sheets.properties(sheetId,title)`,
      );
      const found = meta.sheets.find((s) => s.properties.title === title);
      if (found) return found.properties.sheetId;
      const res = await batchUpdate(id, [{ addSheet: { properties: { title } } }]) as { replies: { addSheet: { properties: { sheetId: number } } }[] };
      return res.replies[0]!.addSheet.properties.sheetId;
    },
    async getValues(id, range) {
      const res = await req<{ values?: string[][] }>('GET', `${base}/${id}/values/${encodeURIComponent(range)}`);
      return res.values ?? [];
    },
    async updateValues(id, range, values) {
      await req('PUT', `${base}/${id}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { range, values });
    },
    async clearValues(id, range) {
      await req('POST', `${base}/${id}/values/${encodeURIComponent(range)}:clear`, {});
    },
    async setDropdown(id, sheetId, col, options) {
      await batchUpdate(id, [
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 },
            rule: {
              condition: { type: 'ONE_OF_LIST', values: options.map((v) => ({ userEnteredValue: v })) },
              showCustomUi: true,
              strict: false,
            },
          },
        },
      ]);
    },
    async freezeHeader(id, sheetId) {
      await batchUpdate(id, [
        { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      ]);
    },
  };
}
